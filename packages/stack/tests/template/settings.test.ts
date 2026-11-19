// @vitest-environment happy-dom
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {createElement as h} from "react";
import {cleanup, fireEvent, render, screen} from "@testing-library/react";
import {MemoryRouter} from "react-router";
import {UserContext, type UserContextType} from "toto-stack/client";
import {UserAuthState} from "toto-stack/shared";
import Settings from "@client/pages/Settings";

vi.mock("@client/components/settings/UsersSettings", () => ({UsersSettings: () => h("p", null, "User management controls")}));
vi.mock("@client/components/settings/NotificationsSettings", () => ({NotificationsSettings: () => h("p", null, "Notification controls")}));
vi.mock("@client/components/settings/ServiceSettings", () => ({ServiceSettings: () => h("p", null, "Service health controls")}));
afterEach(cleanup);
beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({status: "success", data: {
        account: {id: 1, username: "alice", roles: [], otpEnabled: false, apiKeyEnabled: false}, sessions: [],
    }}))));
});
function show(roles: string[], entry = "/admin/settings") {
    const context: UserContextType = {
        user: {id: 1, username: "alice", roles},
        setUser: vi.fn(), loading: false, authStage: UserAuthState.AUTHENTICATED,
        setAuthStage: vi.fn(), logout: vi.fn(),
    };
    render(h(UserContext.Provider, {value: context}, h(MemoryRouter, {initialEntries: [entry]}, h(Settings))));
}
it("makes account controls available to ordinary signed-in users without admin controls", async () => {
    show([]);
    expect(screen.getByText("alice")).toBeTruthy();
    expect(await screen.findByRole("button", {name: "Update password"})).toBeTruthy();
    expect(screen.queryByRole("link", {name: "Users"})).toBeNull();
    expect(screen.queryByRole("link", {name: "Notifications"})).toBeNull();
});
it("offers owner settings and navigates between functional sections", async () => {
    show(["owner"]);
    fireEvent.click(screen.getByRole("link", {name: "Users"}));
    expect(screen.getByText("User management controls")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", {name: "Security"}));
    expect(await screen.findByRole("heading", {name: "Two-factor authentication"})).toBeTruthy();
    fireEvent.click(screen.getByRole("link", {name: "Service"}));
    expect(screen.getByText("Service health controls")).toBeTruthy();
});
it("does not mount admin sections from a direct URL for an ordinary user", async () => {
    show([], "/admin/settings?section=users");
    expect(screen.queryByText("User management controls")).toBeNull();
    expect(await screen.findByRole("button", {name: "Update password"})).toBeTruthy();
});
