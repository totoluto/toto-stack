// @vitest-environment happy-dom
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {createElement as h} from "react";
import {cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {clearCsrfToken} from "toto-stack/client";
import {AccountSettings} from "@client/components/settings/AccountSettings";

afterEach(cleanup);
const requests: {path: string; body: unknown; method: string}[] = [];
let failure = false;
beforeEach(() => {
    requests.length = 0;
    failure = false;
    clearCsrfToken();
    vi.stubGlobal("fetch", vi.fn(async (path: string, init: RequestInit = {}) => {
        if (path === "/api/auth/csrf") return new Response(JSON.stringify({status: "success", data: {token: "csrf"}}));
        requests.push({path, body: init.body ? JSON.parse(String(init.body)) : undefined, method: init.method ?? "GET"});
        return new Response(JSON.stringify(failure
            ? {status: "error", message: "Password confirmation failed.", code: "PASSWORD_CONFIRMATION_FAILED"}
            : {status: "success", data: path.endsWith("/api-key") ? {apiKey: "toto_example"} : path.endsWith("/start") ? {qrCode: "data:image/png;base64,", key: "MANUALKEY"} : undefined}), {status: failure ? 403 : 200});
    }));
});

function change(label: string, value: string) {
    fireEvent.change(screen.getByLabelText(label, {exact: true}), {target: {value}});
}

it("changes the password with current-password confirmation and clears credentials", async () => {
    render(h(AccountSettings));
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
    change("Current password", "wrong");
    change("New password", "new-password-123");
    change("Confirm new password", "new-password-123");
    fireEvent.click(screen.getByRole("button", {name: "Update password"}));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Password confirmation failed."));
    expect(screen.queryByText(/Password updated\./)).toBeNull();
});

it("issues a one-time API key and can dismiss or revoke it", async () => {
    render(h(AccountSettings));
    change("Password for API key", "my-password");
    fireEvent.click(screen.getByRole("button", {name: "Generate API key"}));
    await screen.findByDisplayValue("toto_example");
    expect(requests[0]).toEqual({path: "/api/account/api-key", body: {password: "my-password"}, method: "POST"});
    fireEvent.click(screen.getByRole("button", {name: "Hide API key"}));
    expect(screen.queryByDisplayValue("toto_example")).toBeNull();
    fireEvent.click(screen.getByRole("button", {name: "Revoke API key"}));
    expect(requests).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", {name: "Confirm revoke key"}));
    await screen.findByText("API key revoked.");
    expect(screen.queryByText("API key generated. Save it before leaving this page.")).toBeNull();
    expect(requests[1]).toEqual({path: "/api/account/api-key", body: undefined, method: "DELETE"});
});

it("clears a revealed API key after changing the password", async () => {
    render(h(AccountSettings));
    change("Password for API key", "my-password");
    fireEvent.click(screen.getByRole("button", {name: "Generate API key"}));
    await screen.findByDisplayValue("toto_example");
    change("Current password", "my-password");
    change("New password", "new-password-123");
    change("Confirm new password", "new-password-123");
    fireEvent.click(screen.getByRole("button", {name: "Update password"}));
    await screen.findByText(/Password updated\./);
    expect(screen.queryByDisplayValue("toto_example")).toBeNull();
});

it("revokes a known session ID with password confirmation", async () => {
    render(h(AccountSettings));
    change("Session ID", "known-session");
    change("Password for session", "my-password");
    fireEvent.click(screen.getByRole("button", {name: "Revoke session"}));
    await screen.findByText("Session revocation requested. The session ID must belong to your account.");
    expect(requests[0]).toEqual({path: "/api/account/revoke-session", body: {password: "my-password", sessionID: "known-session"}, method: "POST"});
});
