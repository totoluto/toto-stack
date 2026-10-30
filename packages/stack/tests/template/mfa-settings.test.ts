// @vitest-environment happy-dom
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {createElement as h} from "react";
import {cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {clearCsrfToken} from "toto-stack/client";
import {MfaSettings} from "@client/components/settings/MfaSettings";

const requests: {path: string; body: unknown}[] = [];
let failVerify = false;
afterEach(cleanup);
beforeEach(() => {
    requests.length = 0;
    failVerify = false;
    clearCsrfToken();
    vi.stubGlobal("fetch", vi.fn(async (path: string, init: RequestInit = {}) => {
        if (path === "/api/auth/csrf") return new Response(JSON.stringify({status: "success", data: {token: "csrf"}}));
        requests.push({path, body: init.body ? JSON.parse(String(init.body)) : undefined});
        if (failVerify && path.endsWith("/verify")) return new Response(JSON.stringify({status: "error", message: "Invalid MFA token.", code: "MFA_INVALID"}), {status: 400});
        return new Response(JSON.stringify({status: "success", data: path.endsWith("/start") ? {qrCode: "data:image/png;base64,", key: "MANUALKEY"} : undefined}));
    }));
});
function change(label: string, value: string) {
    fireEvent.change(screen.getByLabelText(label), {target: {value}});
}
async function start() {
    render(h(MfaSettings));
    change("Password for two-factor authentication", "my-password");
    fireEvent.click(screen.getByRole("button", {name: "Set up authenticator"}));
    await screen.findByDisplayValue("MANUALKEY");
}
it("enrolls an authenticator and verifies the code, clearing the secret", async () => {
    await start();
    expect(requests[0]).toEqual({path: "/api/account/mfa/start", body: {password: "my-password"}});
    expect(screen.getByAltText("Scan with your authenticator app")).toBeTruthy();
    change("Authenticator code", "123456");
    fireEvent.click(screen.getByRole("button", {name: "Enable two-factor authentication"}));
    await screen.findByText("Two-factor authentication enabled. Other sessions have been signed out.");
    expect(requests[1]).toEqual({path: "/api/account/mfa/verify", body: {token: "123456"}});
    expect(screen.queryByDisplayValue("MANUALKEY")).toBeNull();
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
    render(h(MfaSettings));
    fireEvent.click(screen.getByRole("button", {name: "Turn off two-factor authentication"}));
    expect(requests).toEqual([]);
    change("Password to turn off two-factor", "my-password");
    change("Current authenticator code", "654321");
    fireEvent.click(screen.getByRole("button", {name: "Confirm turn off"}));
    await screen.findByText("Two-factor authentication disabled. Other sessions have been signed out.");
    expect(requests[0]).toEqual({path: "/api/account/mfa/disable", body: {password: "my-password", token: "654321"}});
});
it("can cancel enrollment without retaining its secret", async () => {
    await start();
    fireEvent.click(screen.getByRole("button", {name: "Cancel setup"}));
    expect(screen.queryByDisplayValue("MANUALKEY")).toBeNull();
    expect(screen.queryByAltText("Scan with your authenticator app")).toBeNull();
});
