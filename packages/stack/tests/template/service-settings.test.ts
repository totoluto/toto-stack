// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createElement as h} from "react";
import {cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {clearCsrfToken} from "toto-stack/client";
import {NotificationsSettings} from "@client/components/settings/NotificationsSettings";
import {ServiceSettings} from "@client/components/settings/ServiceSettings";

beforeEach(() => clearCsrfToken());
afterEach(cleanup);
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {status, headers: {"Content-Type": "application/json"}});
const envelope = (data: unknown) => json({status: "success", message: "", data});

describe("Service settings", () => {
    it("disables duplicate checks while pending and rejects a malformed readiness response", async () => {
        let release!: (response: Response) => void;
        const held = new Promise<Response>(resolve => { release = resolve; });
        const fetch = vi.fn(() => held);
        vi.stubGlobal("fetch", fetch);
        render(h(ServiceSettings));
        fireEvent.click(screen.getByRole("button", {name: "Check health"}));
        const pending = screen.getByRole("button", {name: "Checking health…"}) as HTMLButtonElement;
        expect(pending.disabled).toBe(true);
        fireEvent.click(pending);
        expect(fetch).toHaveBeenCalledTimes(1);
        release(json({status: "success", data: {status: "ok", db: "ok", uptimeSeconds: 42}}));
        expect((await screen.findByRole("alert")).textContent).toContain("Unexpected health response");
        expect(screen.queryByLabelText("Service status")).toBeNull();
        expect((screen.getByRole("button", {name: "Check health"}) as HTMLButtonElement).disabled).toBe(false);
    });
    it("shows degraded 503 readiness and retries a network failure", async () => {
        const fetch = vi.fn()
            .mockRejectedValueOnce(new TypeError("offline"))
            .mockResolvedValueOnce(json({status: "degraded", db: "down", uptimeSeconds: 9}, 503))
            .mockResolvedValueOnce(json({message: "bad gateway"}, 502));
        vi.stubGlobal("fetch", fetch);
        render(h(ServiceSettings));
        fireEvent.click(screen.getByRole("button", {name: "Check health"}));
        expect((await screen.findByRole("alert")).textContent).toContain("Can't reach the server");
        fireEvent.click(screen.getByRole("button", {name: "Check health"}));
        await screen.findByText("9 seconds");
        expect(screen.queryByRole("alert")).toBeNull();
        expect(screen.getByLabelText("Service status").textContent).toBe("degraded");
        expect(screen.getByLabelText("Database status").textContent).toBe("down");
        fireEvent.click(screen.getByRole("button", {name: "Check health"}));
        await screen.findByRole("alert");
        expect(screen.queryByLabelText("Service status")).toBeNull();
    });
    it("checks health only on demand and reads its plain response", async () => {
        const fetch = vi.fn(async (input: RequestInfo | URL) => {
            expect(String(input)).toBe("/api/health");
            return json({status: "ok", db: "ok", uptimeSeconds: 1234});
        });
        vi.stubGlobal("fetch", fetch);
        render(h(ServiceSettings));
        expect(fetch).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", {name: "Check health"}));
        await screen.findByText("1234 seconds");
        expect(screen.getByLabelText("Service status").textContent).toBe("ok");
        expect(screen.getByLabelText("Database status").textContent).toBe("ok");
        expect(String(fetch.mock.calls[0]?.[0])).toBe("/api/health");
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});


describe("Notification settings", () => {
    it("shows every failed handler on delivery errors and clears failure on a successful retry", async () => {
        let attempts = 0;
        vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
            if (String(input) === "/api/auth/csrf") return envelope({token: "t"});
            if (String(input) === "/api/notifications/handlers") return envelope({handlers: ["ops"]});
            if (++attempts === 1) return json({status: "error", code: "DELIVERY_FAILED", message: "The notification could not be delivered.", details: {results: [{handler: "ops", ok: false}]}}, 502);
            return envelope({delivered: 1, failed: 0, results: [{handler: "ops", ok: true}]});
        }));
        render(h(NotificationsSettings));
        fireEvent.click(await screen.findByRole("checkbox", {name: "ops"}));
        fireEvent.change(screen.getByLabelText("Title"), {target: {value: "Title"}});
        fireEvent.change(screen.getByLabelText("Message"), {target: {value: "Message"}});
        fireEvent.click(screen.getByRole("button", {name: "Send notification"}));
        expect((await screen.findByRole("alert")).textContent).toBe("The notification could not be delivered.");
        expect(screen.getByText("ops: Failed")).toBeTruthy();
        expect(screen.getByText("0 delivered, 1 failed.")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", {name: "Send notification"}));
        await screen.findByText("1 delivered, 0 failed.");
        expect(screen.queryByRole("alert")).toBeNull();
        expect(screen.queryByText("ops: Failed")).toBeNull();
        expect(screen.getByText("ops: Delivered")).toBeTruthy();
    });
    it("requires explicit recipients and sends only selected handlers with CSRF, showing partial delivery", async () => {
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const bodies: unknown[] = [];
        const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
            if (String(input) === "/api/auth/csrf") return envelope({token: "csrf-test"});
            if (String(input) === "/api/notifications/handlers") return envelope({handlers: ["ops", "email", "unused"]});
            expect(String(input)).toBe("/api/notifications/send");
            expect(init.method).toBe("POST");
            expect(new Headers(init.headers).get("X-CSRF-Token")).toBe("csrf-test");
            bodies.push(JSON.parse(String(init.body)));
            await held;
            return envelope({delivered: 1, failed: 1, results: [{handler: "ops", ok: true}, {handler: "email", ok: false}]});
        });
        vi.stubGlobal("fetch", fetch);
        render(h(NotificationsSettings));
        await screen.findByRole("checkbox", {name: "ops"});
        fireEvent.change(screen.getByLabelText("Title"), {target: {value: " Test title "}});
        fireEvent.change(screen.getByLabelText("Message"), {target: {value: " Test message "}});
        const send = screen.getByRole("button", {name: "Send notification"}) as HTMLButtonElement;
        expect(send.disabled).toBe(true);
        fireEvent.submit(send.closest("form")!);
        expect(bodies).toHaveLength(0);
        fireEvent.click(screen.getByRole("checkbox", {name: "ops"}));
        fireEvent.click(screen.getByRole("checkbox", {name: "email"}));
        expect(send.disabled).toBe(false);
        fireEvent.click(send);
        fireEvent.submit(send.closest("form")!);
        await waitFor(() => expect(bodies).toHaveLength(1));
        expect(send.disabled).toBe(true);
        release();
        await screen.findByText("1 delivered, 1 failed.");
        expect(screen.getByText("ops: Delivered")).toBeTruthy();
        expect(screen.getByText("email: Failed")).toBeTruthy();
        expect(bodies).toEqual([{title: "Test title", message: "Test message", handlers: ["ops", "email"]}]);
        expect(send.disabled).toBe(false);
    });
    it("loads configured handlers on mount and offers retry after failure and empty state", async () => {
        const fetch = vi.fn()
            .mockRejectedValueOnce(new TypeError("offline"))
            .mockResolvedValueOnce(envelope({handlers: []}));
        vi.stubGlobal("fetch", fetch);
        render(h(NotificationsSettings));
        expect((screen.getByRole("button", {name: "Send notification"}) as HTMLButtonElement).disabled).toBe(true);
        expect((await screen.findByRole("alert")).textContent).toContain("Can't reach the server");
        fireEvent.click(screen.getByRole("button", {name: "Retry handlers"}));
        await screen.findByText("No notification handlers are configured.");
        expect(screen.queryByRole("alert")).toBeNull();
        expect((screen.getByRole("button", {name: "Send notification"}) as HTMLButtonElement).disabled).toBe(true);
        expect(fetch.mock.calls.map(call => call[0])).toEqual(["/api/notifications/handlers", "/api/notifications/handlers"]);
    });
});
