// @vitest-environment happy-dom
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {createElement as h} from "react";
import {cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {clearCsrfToken} from "toto-stack/client";
import {MfaSettings} from "@client/components/settings/MfaSettings";

const requests: {path: string; body: unknown}[] = [];
let failVerify = false;
let otpEnabled = false;
let accountFailure = false;
afterEach(cleanup);
beforeEach(() => {
    requests.length = 0;
    failVerify = false;
    otpEnabled = false;
    accountFailure = false;
    clearCsrfToken();
    vi.stubGlobal("fetch", vi.fn(async (path: string, init: RequestInit = {}) => {
        if (path === "/api/auth/csrf") return new Response(JSON.stringify({status: "success", data: {token: "csrf"}}));
        if (path === "/api/account") return new Response(JSON.stringify(accountFailure ? {status: "error", message: "Account unavailable"} : {status: "success", data: {account: {id: 1, username: "alice", roles: [], otpEnabled, apiKeyEnabled: false}, sessions: []}}), {status: accountFailure ? 503 : 200});
        requests.push({path, body: init.body ? JSON.parse(String(init.body)) : undefined});
        if (failVerify && path.endsWith("/verify")) return new Response(JSON.stringify({status: "error", message: "Invalid MFA token.", code: "MFA_INVALID"}), {status: 400});
        if (path.endsWith("/verify")) otpEnabled = true;
        if (path.endsWith("/disable")) otpEnabled = false;
        return new Response(JSON.stringify({status: "success", data: path.endsWith("/start") ? {qrCode: "data:image/png;base64,", key: "MANUALKEY"} : undefined}));
    }));
});
function change(label: string, value: string) {
    fireEvent.change(screen.getByLabelText(label), {target: {value}});
}
async function start() {
    render(h(MfaSettings));
    await screen.findByText("Two-factor authentication is disabled.");
    change("Password for two-factor authentication", "my-password");
    fireEvent.click(screen.getByRole("button", {name: "Set up authenticator"}));
    await screen.findByDisplayValue("MANUALKEY");
}
it("does not treat a failed account load as disabled and can retry", async () => {
    accountFailure = true;
    otpEnabled = true;
    render(h(MfaSettings));
    expect((await screen.findByRole("alert")).textContent).toBe("Account unavailable");
    expect(screen.queryByText("Two-factor authentication is disabled.")).toBeNull();
    expect(screen.queryByRole("button", {name: "Set up authenticator"})).toBeNull();
    accountFailure = false;
    fireEvent.click(screen.getByRole("button", {name: "Retry"}));
    await screen.findByText("Two-factor authentication is enabled.");
});

it("loads the disabled status and offers setup only", async () => {
    render(h(MfaSettings));
    expect(screen.getByText("Loading account…")).toBeTruthy();
    expect(screen.queryByRole("button", {name: "Set up authenticator"})).toBeNull();
    await screen.findByText("Two-factor authentication is disabled.");
    expect(screen.getByRole("button", {name: "Set up authenticator"})).toBeTruthy();
    expect(screen.queryByRole("button", {name: "Turn off two-factor authentication"})).toBeNull();
});

it("enrolls an authenticator and verifies the code, clearing the secret", async () => {
    await start();
    expect(requests[0]).toEqual({path: "/api/account/mfa/start", body: {password: "my-password"}});
    expect(screen.getByAltText("Scan with your authenticator app")).toBeTruthy();
    change("Authenticator code", "123456");
    fireEvent.click(screen.getByRole("button", {name: "Enable two-factor authentication"}));
    await screen.findByText("Two-factor authentication enabled. Other sessions have been signed out.");
    expect(requests[1]).toEqual({path: "/api/account/mfa/verify", body: {token: "123456"}});
    expect(screen.queryByDisplayValue("MANUALKEY")).toBeNull();
    await screen.findByText("Two-factor authentication is enabled.");
    expect(screen.queryByRole("button", {name: "Set up authenticator"})).toBeNull();
    expect(screen.getByRole("button", {name: "Turn off two-factor authentication"})).toBeTruthy();
});
it("keeps enrollment available after an invalid code", async () => {
    await start();
    failVerify = true;
    change("Authenticator code", "123456");
    fireEvent.click(screen.getByRole("button", {name: "Enable two-factor authentication"}));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Invalid MFA token."));
    expect(screen.getByDisplayValue("MANUALKEY")).toBeTruthy();
});
it("requires an explicit warning step before disabling MFA", async () => {
    otpEnabled = true;
    render(h(MfaSettings));
    await screen.findByText("Two-factor authentication is enabled.");
    expect(screen.queryByRole("button", {name: "Set up authenticator"})).toBeNull();
    fireEvent.click(screen.getByRole("button", {name: "Turn off two-factor authentication"}));
    expect(requests).toEqual([]);
    change("Password to turn off two-factor", "my-password");
    change("Current authenticator code", "654321");
    fireEvent.click(screen.getByRole("button", {name: "Confirm turn off"}));
    await screen.findByText("Two-factor authentication disabled. Other sessions have been signed out.");
    expect(requests[0]).toEqual({path: "/api/account/mfa/disable", body: {password: "my-password", token: "654321"}});
    await screen.findByText("Two-factor authentication is disabled.");
    expect(screen.queryByLabelText("Current authenticator code")).toBeNull();
    expect(screen.queryByRole("button", {name: "Turn off two-factor authentication"})).toBeNull();
});
it("can cancel enrollment without retaining its secret", async () => {
    await start();
    fireEvent.click(screen.getByRole("button", {name: "Cancel setup"}));
    expect(screen.queryByDisplayValue("MANUALKEY")).toBeNull();
    expect(screen.queryByAltText("Scan with your authenticator app")).toBeNull();
});
