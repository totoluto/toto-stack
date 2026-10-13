import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {apiFetch, clearCsrfToken} from "@server/client/helpers";

type JsonBody = Record<string, unknown>;

function jsonResponse(status: number, body: JsonBody) {
    return new Response(JSON.stringify(body), {status, headers: {"Content-Type": "application/json"}});
}

function csrfOk(token = "token-1") {
    return jsonResponse(200, {status: "success", data: {token}});
}

describe("apiFetch", () => {
    const fetchMock = vi.fn();

    beforeEach(() => {
        clearCsrfToken();
        fetchMock.mockReset();
        vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("returns data on success without CSRF for GET", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(200, {status: "success", data: {hello: "world"}}));

        const data = await apiFetch<{hello: string}>("/api/thing");

        expect(data).toEqual({hello: "world"});
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const headers = fetchMock.mock.calls[0][1].headers as Headers;
        expect(headers.has("X-CSRF-Token")).toBe(false);
    });

    it("attaches a CSRF token on POST", async () => {
        fetchMock
            .mockResolvedValueOnce(csrfOk())
            .mockResolvedValueOnce(jsonResponse(200, {status: "success", data: {done: true}}));

        await apiFetch("/api/thing", {method: "POST", body: "{}"});

        expect(fetchMock.mock.calls[0][0]).toBe("/api/auth/csrf");
        const headers = fetchMock.mock.calls[1][1].headers as Headers;
        expect(headers.get("X-CSRF-Token")).toBe("token-1");
    });

    it("retries once with a fresh token on CSRF_INVALID", async () => {
        fetchMock
            .mockResolvedValueOnce(csrfOk())
            .mockResolvedValueOnce(jsonResponse(403, {status: "error", message: "Invalid CSRF token.", code: "CSRF_INVALID"}))
            .mockResolvedValueOnce(csrfOk("token-2"))
            .mockResolvedValueOnce(jsonResponse(200, {status: "success", data: {done: true}}));

        const data = await apiFetch<{done: boolean}>("/api/thing", {method: "POST", body: "{}"});

        expect(data).toEqual({done: true});
        expect(fetchMock).toHaveBeenCalledTimes(4);
        const retryHeaders = fetchMock.mock.calls[3][1].headers as Headers;
        expect(retryHeaders.get("X-CSRF-Token")).toBe("token-2");
    });

    it("does not retry forever on repeated CSRF failures", async () => {
        fetchMock
            .mockResolvedValueOnce(csrfOk())
            .mockResolvedValueOnce(jsonResponse(403, {status: "error", message: "Invalid CSRF token.", code: "CSRF_INVALID"}))
            .mockResolvedValueOnce(csrfOk("token-2"))
            .mockResolvedValueOnce(jsonResponse(403, {status: "error", message: "Invalid CSRF token.", code: "CSRF_INVALID"}));

        await expect(apiFetch("/api/thing", {method: "POST", body: "{}"})).rejects.toThrow("Invalid CSRF token.");
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it("throws the server message on error responses", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(500, {status: "error", message: "Boom"}));

        await expect(apiFetch("/api/thing")).rejects.toThrow("Boom");
    });

    it("caches the CSRF token across requests", async () => {
        fetchMock
            .mockResolvedValueOnce(csrfOk())
            .mockResolvedValueOnce(jsonResponse(200, {status: "success", data: {}}))
            .mockResolvedValueOnce(jsonResponse(200, {status: "success", data: {}}));

        await apiFetch("/api/one", {method: "POST", body: "{}"});
        await apiFetch("/api/two", {method: "POST", body: "{}"});

        // Only one CSRF fetch for two POSTs
        const csrfCalls = fetchMock.mock.calls.filter(call => call[0] === "/api/auth/csrf");
        expect(csrfCalls).toHaveLength(1);
    });
});
