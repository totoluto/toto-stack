import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {ApiError, apiFetch, clearCsrfToken, configureApiClient} from "@server/client/helpers";
import {ErrorCode} from "@shared/errorCodes";
import {sleep} from "./support";

const json = (status: number, body: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(body), {status, ...init, headers: {"Content-Type": "application/json", ...init.headers}});
const ok = (data: unknown) => json(200, {status: "success", message: "ok", data});
const csrfOk = (token: string) => ok({token});
const csrfFailure = (withCode = true) =>
    json(403, {status: "error", message: "Invalid CSRF token.", ...(withCode ? {code: ErrorCode.CSRF_INVALID} : {})});

type Call = {url: string; init: RequestInit; headers: Headers};

/** fetch mock: `/api/auth/csrf` hands out t1, t2, ...; other URLs use `respond`. */
function mockFetch(respond: (call: Call) => Response | Promise<Response>, csrfDelayMs = 0) {
    const calls: Call[] = [];
    let issued = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const call = {url: String(input), init, headers: new Headers(init.headers)};
        calls.push(call);
        if (call.url.endsWith("/api/auth/csrf")) {
            await sleep(csrfDelayMs);
            return csrfOk(`t${++issued}`);
        }
        return respond(call);
    });
    vi.stubGlobal("fetch", fetchMock);
    return {calls, csrfCalls: () => calls.filter(call => call.url.endsWith("/api/auth/csrf")).length};
}

describe("apiFetch", () => {
    beforeEach(() => {
        configureApiClient({baseUrl: "", csrfPath: "/api/auth/csrf"});
        clearCsrfToken();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("shares one in-flight CSRF token request between concurrent mutations (P8)", async () => {
        const mock = mockFetch(() => ok({}), 10);

        await Promise.all([
            apiFetch("/a", {method: "POST", body: "{}"}),
            apiFetch("/b", {method: "PUT", body: "{}"}),
            apiFetch("/c", {method: "DELETE"}),
        ]);

        expect(mock.csrfCalls()).toBe(1);
        expect(mock.calls.filter(call => !call.url.endsWith("/csrf")).map(call => call.headers.get("X-CSRF-Token"))).toEqual(["t1", "t1", "t1"]);
    });

    it("does not cache a token fetched before clearCsrfToken() (session changed mid-flight)", async () => {
        const mock = mockFetch(() => ok({}), 20);

        const first = apiFetch("/a", {method: "POST", body: "{}"});
        await sleep(5);
        clearCsrfToken(); // e.g. login regenerated the session
        await first;
        await apiFetch("/b", {method: "POST", body: "{}"});

        expect(mock.csrfCalls()).toBe(2);
        expect(mock.calls.at(-1)!.headers.get("X-CSRF-Token")).toBe("t2");
    });

    it("retries once with a fresh token on 403 CSRF_INVALID", async () => {
        let attempts = 0;
        const mock = mockFetch(() => (++attempts === 1 ? csrfFailure() : ok({done: true})));

        await expect(apiFetch("/api/thing", {method: "POST", body: "{}"})).resolves.toEqual({done: true});

        expect(attempts).toBe(2);
        expect(mock.csrfCalls()).toBe(2);
        expect(mock.calls.at(-1)!.headers.get("X-CSRF-Token")).toBe("t2");
    });

    it("keys the retry on the code, not on the message", async () => {
        let attempts = 0;
        mockFetch(() => (attempts++, csrfFailure(false)));

        await expect(apiFetch("/api/thing", {method: "POST", body: "{}"})).rejects.toMatchObject({status: 403, code: undefined});
        expect(attempts).toBe(1);
    });

    it("gives up after one retry and does not retry other 403s or safe methods", async () => {
        mockFetch(() => csrfFailure());
        const error = await apiFetch("/api/thing", {method: "POST", body: "{}"}).catch(e => e);
        expect(error).toBeInstanceOf(ApiError);
        expect(error).toMatchObject({status: 403, code: "CSRF_INVALID"});

        clearCsrfToken();
        let forbidden = 0;
        mockFetch(() => (forbidden++, json(403, {status: "error", message: "Missing permissions"})));
        await expect(apiFetch("/api/thing", {method: "POST", body: "{}"})).rejects.toMatchObject({status: 403, message: "Missing permissions"});
        expect(forbidden).toBe(1);
    });

    it("resolves undefined for 204 No Content and empty 200 bodies (P10)", async () => {
        mockFetch(call => (call.url === "/204" ? new Response(null, {status: 204}) : new Response("", {status: 200})));

        await expect(apiFetch("/204", {method: "DELETE"})).resolves.toBeUndefined();
        await expect(apiFetch("/empty")).resolves.toBeUndefined();
    });

    it("throws an ApiError that keeps the status for non-JSON responses (P9)", async () => {
        mockFetch(() => new Response("<html><body>502 Bad Gateway</body></html>", {status: 502, statusText: "Bad Gateway", headers: {"Content-Type": "text/html"}}));

        const error = await apiFetch("/api/x").catch(e => e);

        expect(error).toBeInstanceOf(ApiError);
        expect(error).toMatchObject({status: 502, code: "INVALID_RESPONSE", message: "Request failed with status 502 Bad Gateway."});
        expect(error).not.toBeInstanceOf(SyntaxError);
    });

    it("throws for a 200 that is not JSON, and for empty error responses", async () => {
        mockFetch(call => (call.url === "/html" ? new Response("<html></html>", {status: 200}) : new Response(null, {status: 500})));

        await expect(apiFetch("/html")).rejects.toMatchObject({name: "ApiError", status: 200, code: "INVALID_RESPONSE"});
        await expect(apiFetch("/empty-500")).rejects.toMatchObject({name: "ApiError", status: 500});
    });

    it("exposes the envelope's message, code and details", async () => {
        mockFetch(() => json(400, {status: "error", message: "Invalid request payload.", code: "VALIDATION_FAILED", details: [{path: "title"}]}));

        await expect(apiFetch("/api/x", {method: "POST", body: "{}"})).rejects.toMatchObject({
            status: 400,
            code: "VALIDATION_FAILED",
            message: "Invalid request payload.",
            details: [{path: "title"}],
        });
    });

    it("leaves Content-Type to the browser for FormData, Blob and URLSearchParams (P11)", async () => {
        const mock = mockFetch(() => ok({}));
        const form = new FormData();
        form.append("file", "x");

        await apiFetch("/upload", {method: "POST", body: form});
        await apiFetch("/blob", {method: "POST", body: new Blob(["x"], {type: "text/plain"})});
        await apiFetch("/form", {method: "POST", body: new URLSearchParams({a: "b"})});
        await apiFetch("/json", {method: "POST", body: JSON.stringify({a: 1})});
        await apiFetch("/get");

        const contentType = (url: string) => mock.calls.find(call => call.url === url)!.headers.get("Content-Type");
        expect(contentType("/upload")).toBeNull();
        expect(contentType("/blob")).toBeNull();
        expect(contentType("/form")).toBeNull();
        expect(contentType("/json")).toBe("application/json");
        expect(contentType("/get")).toBeNull();
        expect(mock.calls.find(call => call.url === "/upload")!.init.body).toBe(form);
    });

    it("keeps an explicit Content-Type and sends credentials", async () => {
        const mock = mockFetch(() => ok({}));

        await apiFetch("/csv", {method: "POST", body: "a,b", headers: {"Content-Type": "text/csv"}});

        const call = mock.calls.find(c => c.url === "/csv")!;
        expect(call.headers.get("Content-Type")).toBe("text/csv");
        expect(call.init.credentials).toBe("include");
        expect(mock.calls[0].init.credentials).toBe("include");
    });

    it("uses the configured base URL and CSRF path for relative paths only", async () => {
        configureApiClient({baseUrl: "https://api.example.com/", csrfPath: "/auth/token"});
        const calls: string[] = [];
        vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
            calls.push(String(input));
            return String(input).endsWith("/auth/token") ? csrfOk("t") : ok({});
        }));

        await apiFetch("/api/things", {method: "POST", body: "{}"});
        await apiFetch("https://other.example.com/x");

        expect(calls).toEqual(["https://api.example.com/auth/token", "https://api.example.com/api/things", "https://other.example.com/x"]);
    });

    it("validates data with `parse` and infers the type from it", async () => {
        mockFetch(() => ok({count: "3"}));
        const parseCount = (data: unknown): {count: number} => {
            const count = Number((data as {count?: unknown})?.count);
            if (!Number.isInteger(count)) throw new Error("bad count");
            return {count};
        };

        const result = await apiFetch("/count", {parse: parseCount});
        const typed: {count: number} = result;

        expect(typed).toEqual({count: 3});
    });
});
