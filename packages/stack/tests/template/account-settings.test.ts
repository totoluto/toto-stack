// @vitest-environment happy-dom
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {createElement as h} from "react";
import {act, cleanup, fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import {clearCsrfToken} from "toto-stack/client";
import {AccountSettings} from "@client/components/settings/AccountSettings";

afterEach(cleanup);
const requests: {path: string; body: unknown; method: string}[] = [];
const currentSession = {id: "opaque-current", current: true, ipAddress: null, userAgent: null, createdAt: "2026-11-01T10:00:00Z", lastSeenAt: "2026-11-19T10:00:00Z", expiresAt: "2026-12-01T10:00:00Z"};
const otherSession = {...currentSession, id: "opaque/handle:do-not-parse", current: false, ipAddress: "192.0.2.10", userAgent: "Mozilla/5.0 (X11; Linux x86_64) Firefox/132.0"};
let sessionsRevoked = false;
let failure = false;
let accountFailure = false;
let apiKeyEnabled = false;
let releaseAccount: (() => void) | undefined;
beforeEach(() => {
    requests.length = 0;
    failure = false;
    sessionsRevoked = false;
    accountFailure = false;
    apiKeyEnabled = false;
    releaseAccount = undefined;
    clearCsrfToken();
    vi.stubGlobal("fetch", vi.fn(async (path: string, init: RequestInit = {}) => {
        if (path === "/api/auth/csrf") return new Response(JSON.stringify({status: "success", data: {token: "csrf"}}));
        if (path === "/api/account") {
            if (releaseAccount) await new Promise<void>(resolve => {releaseAccount = resolve;});
            return new Response(JSON.stringify(accountFailure ? {status: "error", message: "Account unavailable"} : {status: "success", data: {account: {id: 1, username: "alice", roles: [], otpEnabled: false, apiKeyEnabled}, sessions: sessionsRevoked ? [currentSession] : [currentSession, otherSession]}}), {status: accountFailure ? 503 : 200});
        }
        if (!failure && path === "/api/account/api-key") apiKeyEnabled = init.method === "POST";
        if (!failure && path === "/api/account/password") {apiKeyEnabled = false; sessionsRevoked = true;}
        requests.push({path, body: init.body ? JSON.parse(String(init.body)) : undefined, method: init.method ?? "GET"});
        return new Response(JSON.stringify(failure
            ? {status: "error", message: "Password confirmation failed.", code: "PASSWORD_CONFIRMATION_FAILED"}
            : {status: "success", data: path.endsWith("/api-key") ? {apiKey: "toto_example"} : path.endsWith("/start") ? {qrCode: "data:image/png;base64,", key: "MANUALKEY"} : undefined}), {status: failure ? 403 : 200});
    }));
});

function change(label: string, value: string) {
    fireEvent.change(screen.getByLabelText(label, {exact: true}), {target: {value}});
}

it("loads the configured API key status before enabling account actions", async () => {
    apiKeyEnabled = true;
    releaseAccount = () => {};
    render(h(AccountSettings));
    expect(screen.getByText("Loading account…")).toBeTruthy();
    expect(screen.queryByRole("button", {name: "Generate API key"})).toBeNull();
    releaseAccount();
    await screen.findByText("API key configured.");
});

it("shows load failure without unsafe controls and retries", async () => {
    accountFailure = true;
    render(h(AccountSettings));
    expect((await screen.findByRole("alert")).textContent).toBe("Account unavailable");
    expect(screen.queryByRole("button", {name: "Generate API key"})).toBeNull();
    accountFailure = false;
    fireEvent.click(screen.getByRole("button", {name: "Retry"}));
    await screen.findByText("No API key configured.");
});

it("changes the password with current-password confirmation and clears credentials", async () => {
    render(h(AccountSettings));
    await screen.findByText("No API key configured.");
    change("Current password", "old-password");
    change("New password", "new-password-123");
    change("Confirm new password", "new-password-123");
    fireEvent.click(screen.getByRole("button", {name: "Update password"}));
    await screen.findByText("Password updated. Other sessions are signed out and your API key is revoked.");
    expect(requests).toEqual([{path: "/api/account/password", body: {currentPassword: "old-password", newPassword: "new-password-123"}, method: "POST"}]);
    expect((screen.getByLabelText("Current password", {exact: true}) as HTMLInputElement).value).toBe("");
});

it("rejects mismatched passwords without sending a request", async () => {
    render(h(AccountSettings));
    await screen.findByText("No API key configured.");
    change("Current password", "old-password");
    change("New password", "new-password-123");
    change("Confirm new password", "different-password");
    fireEvent.click(screen.getByRole("button", {name: "Update password"}));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "The new passwords do not match.");
    expect(requests).toEqual([]);
});

it("shows API errors instead of announcing success", async () => {
    failure = true;
    render(h(AccountSettings));
    await screen.findByText("No API key configured.");
    change("Current password", "wrong");
    change("New password", "new-password-123");
    change("Confirm new password", "new-password-123");
    fireEvent.click(screen.getByRole("button", {name: "Update password"}));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Password confirmation failed."));
    expect(screen.queryByText(/Password updated\./)).toBeNull();
});

it("issues a one-time API key and can dismiss or revoke it", async () => {
    render(h(AccountSettings));
    await screen.findByText("No API key configured.");
    change("Password for API key", "my-password");
    fireEvent.click(screen.getByRole("button", {name: "Generate API key"}));
    await screen.findByDisplayValue("toto_example");
    await screen.findByText("API key configured.");
    expect(requests[0]).toEqual({path: "/api/account/api-key", body: {password: "my-password"}, method: "POST"});
    fireEvent.click(screen.getByRole("button", {name: "Hide API key"}));
    expect(screen.queryByDisplayValue("toto_example")).toBeNull();
    fireEvent.click(screen.getByRole("button", {name: "Revoke API key"}));
    expect(requests).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", {name: "Confirm revoke key"}));
    await screen.findByText("API key revoked.");
    await screen.findByText("No API key configured.");
    expect(screen.queryByText("API key generated. Save it before leaving this page.")).toBeNull();
    expect(requests[1]).toEqual({path: "/api/account/api-key", body: undefined, method: "DELETE"});
});

it("clears a revealed API key after changing the password", async () => {
    render(h(AccountSettings));
    await screen.findByText("No API key configured.");
    change("Password for API key", "my-password");
    fireEvent.click(screen.getByRole("button", {name: "Generate API key"}));
    await screen.findByDisplayValue("toto_example");
    change("Current password", "my-password");
    change("New password", "new-password-123");
    change("Confirm new password", "new-password-123");
    fireEvent.click(screen.getByRole("button", {name: "Update password"}));
    await screen.findByText(/Password updated\./);
    expect(screen.queryByDisplayValue("toto_example")).toBeNull();
    await screen.findByText("No API key configured.");
    await waitFor(() => expect(screen.queryByText("Firefox · Computer")).toBeNull());
});

it("refreshes again after overlapping mutations and awaits the final account snapshot", async () => {
    let releaseStale!: () => void;
    let releaseLatest!: () => void;
    const staleRead = new Promise<void>(resolve => {releaseStale = resolve;});
    const latestRead = new Promise<void>(resolve => {releaseLatest = resolve;});
    const fetch = globalThis.fetch;
    let accountReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (path: string, init: RequestInit = {}) => {
        const read = path === "/api/account" ? ++accountReads : 0;
        // Capture the backend snapshot before holding the response in flight.
        const response = await fetch(path, init);
        if (read === 2) await staleRead;
        if (read === 3) await latestRead;
        return response;
    }));
    try {
        render(h(AccountSettings));
        await screen.findByText("No API key configured.");
        change("Password for API key", "my-password");
        fireEvent.click(screen.getByRole("button", {name: "Generate API key"}));
        await waitFor(() => expect(accountReads).toBe(2));
        change("Current password", "my-password");
        change("New password", "new-password-123");
        change("Confirm new password", "new-password-123");
        await act(async () => {
            fireEvent.click(screen.getByRole("button", {name: "Update password"}));
        });
        expect(requests.map(request => request.path)).toEqual(["/api/account/api-key", "/api/account/password"]);
        await act(async () => {releaseStale();});
        await waitFor(() => expect(accountReads).toBe(3));
        expect(screen.queryByText(/Password updated\./)).toBeNull();
        expect(screen.getAllByRole("button", {name: "Saving…"})).toHaveLength(2);
        await act(async () => {releaseLatest();});
        await screen.findByText(/Password updated\./);
        expect(screen.getByText("No API key configured.")).toBeTruthy();
        expect(screen.queryByText("Firefox · Computer")).toBeNull();
        expect(screen.queryByDisplayValue("toto_example")).toBeNull();
        expect(screen.queryByRole("button", {name: "Saving…"})).toBeNull();
        expect(accountReads).toBe(3);
    } finally {
        await act(async () => {releaseStale(); releaseLatest();});
    }
});

it("lists owned session metadata and revokes only a selected non-current opaque handle", async () => {
    render(h(AccountSettings));
    await screen.findByText("Firefox · Computer");
    expect(screen.queryByLabelText("Session ID")).toBeNull();
    const current = screen.getByText("Current session").closest("li")!;
    expect(within(current).queryByRole("button", {name: "Revoke session"})).toBeNull();
    expect(within(current).getByText(/Use Log out/)).toBeTruthy();
    const other = screen.getByText("Firefox · Computer").closest("li")!;
    expect(within(other).getByText(/192\.0\.2\.10/)).toBeTruthy();
    expect(other.querySelectorAll("time")).toHaveLength(3);
    expect(other.querySelector("time")!.textContent).not.toBe(otherSession.createdAt);
    fireEvent.click(within(other).getByRole("button", {name: "Revoke session"}));
    expect(requests).toEqual([]);
    change("Password for session", "my-password");
    sessionsRevoked = true;
    fireEvent.click(screen.getByRole("button", {name: "Confirm revoke session"}));
    await screen.findByText("Session revoked.");
    expect(requests[0]).toEqual({path: "/api/account/revoke-session", body: {password: "my-password", sessionID: otherSession.id}, method: "POST"});
    await waitFor(() => expect(screen.queryByText("Firefox · Computer")).toBeNull());
    expect(screen.queryByLabelText("Password for session")).toBeNull();
});

it.each([
    ["Mozilla/5.0 (iPhone) Version/18.0 Mobile/15E148 Safari/604.1", "Safari · Phone"],
    ["Mozilla/5.0 (iPad) Version/18.0 Mobile/15E148 Safari/604.1", "Safari · Tablet"],
    ["Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Safari/537.36", "Chrome · Tablet"],
    ["Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36", "Chrome · Phone"],
    ["Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36 Edg/130.0", "Edge · Computer"],
    ["Unrecognized client", "Unknown device"],
])("shows a compact device label for %s", async (userAgent, label) => {
    const fetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
        if (path !== "/api/account") return fetch(path, init);
        return new Response(JSON.stringify({status: "success", data: {account: {apiKeyEnabled: false}, sessions: [{...otherSession, userAgent}]}}));
    }));
    render(h(AccountSettings));
    const row = (await screen.findByText(label)).closest("li")!;
    expect(row.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    const details = row.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(within(details).getByText(userAgent)).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", {name: "Revoke session"}));
    expect(await screen.findByLabelText("Password for session")).toBeTruthy();
});
