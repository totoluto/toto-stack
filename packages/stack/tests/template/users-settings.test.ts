// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createElement as h} from "react";
import {cleanup, fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import {clearCsrfToken, UserAuthState, UserContext, type UserContextType} from "toto-stack/client";
import {UsersSettings} from "@client/components/settings/UsersSettings";

const users = [
    {id: 1, username: "primary-owner", roles: ["owner"], otpEnabled: true, createdAt: "2026-01-01T00:00:00Z"},
    {id: 2, username: "current-admin", roles: ["admin"], otpEnabled: false, createdAt: "2026-01-02T00:00:00Z"},
    {id: 3, username: "other-admin", roles: ["admin"], otpEnabled: true, createdAt: "2026-01-03T00:00:00Z"},
    {id: 4, username: "app-user", roles: ["editor"], otpEnabled: false, createdAt: "2026-01-04T00:00:00Z"},
];
const envelope = (data: unknown, status = 200, message = "", code?: string, details?: unknown) => new Response(
    JSON.stringify({status: status < 400 ? "success" : "error", data, message, code, details}),
    {status, headers: {"Content-Type": "application/json"}},
);
function mount(roles = ["admin"], id = 2) {
    const value: UserContextType = {
        user: {id, username: "actor", roles}, loading: false, authStage: UserAuthState.AUTHENTICATED,
        setUser: () => undefined, setAuthStage: () => undefined, logout: async () => undefined,
    };
    return render(h(UserContext.Provider, {value}, h(UsersSettings)));
}
function mockApi(handler?: (url: string, init: RequestInit) => Response | Promise<Response> | undefined) {
    const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input);
        if (url === "/api/auth/csrf") return envelope({token: "token"});
        const answer = handler?.(url, init);
        if (answer) return answer;
        if (url === "/api/users" && (!init.method || init.method === "GET")) return envelope({users});
        throw new Error(`Unexpected request: ${init.method} ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    return fetch;
}
const row = (name: string) => within(screen.getByRole("row", {name: new RegExp(name)}));
const disabled = (element: HTMLElement) => (element as HTMLButtonElement).disabled;

beforeEach(clearCsrfToken);
afterEach(cleanup);

describe("Users settings", () => {
    it.each([
        {status: 400, code: "VALIDATION_FAILED", message: "Invalid request", details: [{path: "roles.0", message: "Unknown role"}], expected: "roles.0: Unknown role", roles: "unknown-role"},
        {status: 409, code: "USERNAME_TAKEN", message: "Username already taken.", expected: "Username already taken.", roles: ""},
        {status: 403, code: "ROLE_NOT_GRANTABLE", message: "You may not grant this role.", expected: "You may not grant this role.", roles: "editor"},
    ])("surfaces $code from the server, clears passwords and permits corrected retries", async ({status, code, message, details, expected, roles}) => {
        let posts = 0;
        const fetch = mockApi((url, init) => init.method === "POST" ? (++posts === 1
            ? envelope(undefined, status, message, code, details)
            : envelope({user: {id: 5, username: "new-user", roles: []}}, 201)) : undefined);
        mount();
        await screen.findByRole("table", {name: "Users"});
        fireEvent.change(screen.getByLabelText("Username"), {target: {value: "new-user"}});
        fireEvent.change(screen.getByLabelText("Password"), {target: {value: "new-password-123"}});
        fireEvent.change(screen.getByLabelText("Roles"), {target: {value: roles}});
        fireEvent.submit(screen.getByRole("form", {name: "Create user"}));
        expect((await screen.findByRole("alert")).textContent).toBe(expected);
        expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
        expect((screen.getByLabelText("Username") as HTMLInputElement).value).toBe("new-user");
        const post = fetch.mock.calls.find(([, init]) => init?.method === "POST")!;
        expect(JSON.parse(String(post[1]?.body)).roles).toEqual(roles ? [roles] : []);
        expect(screen.queryByText("User created.")).toBeNull();
        fireEvent.change(screen.getByLabelText("Roles"), {target: {value: ""}});
        fireEvent.change(screen.getByLabelText("Password"), {target: {value: "retry-password-123"}});
        fireEvent.submit(screen.getByRole("form", {name: "Create user"}));
        await screen.findByText("User created.");
        expect(screen.queryByRole("alert")).toBeNull();
        expect(posts).toBe(2);
    });

    it.each([
        [403, "USER_PROTECTED", "Owner accounts cannot be deleted."],
        [404, "USER_NOT_FOUND", "User not found."],
    ])("shows a server delete rejection (%s) without removing the user or claiming success", async (status, code, message) => {
        mockApi((url, init) => init.method === "DELETE" ? envelope(undefined, status, message, code) : undefined);
        mount();
        await screen.findByRole("table", {name: "Users"});
        fireEvent.click(row("app-user").getByRole("button", {name: "Delete app-user"}));
        fireEvent.click(row("app-user").getByRole("button", {name: "Confirm delete app-user"}));
        expect((await screen.findByRole("alert")).textContent).toBe(message);
        expect(screen.getByRole("row", {name: /app-user/})).toBeTruthy();
        expect(screen.queryByText("User deleted.")).toBeNull();
        expect(disabled(row("app-user").getByRole("button", {name: "Confirm delete app-user"}))).toBe(false);
    });

    it("separates successful creation from a failed list refresh and offers retry", async () => {
        let gets = 0;
        mockApi((url, init) => {
            if (init.method === "POST") return envelope({user: {id: 5}}, 201);
            if (++gets === 2) return envelope(undefined, 403, "Missing permissions", "FORBIDDEN");
            return undefined;
        });
        mount();
        await screen.findByRole("table", {name: "Users"});
        fireEvent.change(screen.getByLabelText("Username"), {target: {value: "new-user"}});
        fireEvent.change(screen.getByLabelText("Password"), {target: {value: "new-password-123"}});
        fireEvent.submit(screen.getByRole("form", {name: "Create user"}));
        expect((await screen.findByRole("alert")).textContent).toContain("permission");
        expect(screen.getByText("User created.")).toBeTruthy();
        expect(screen.queryByRole("table", {name: "Users"})).toBeNull();
        fireEvent.click(screen.getByRole("button", {name: "Retry loading users"}));
        await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
        await screen.findByRole("table", {name: "Users"});
        expect(gets).toBe(3);
    });

    it("shows an explicit empty state when no users are returned", async () => {
        mockApi(() => envelope({users: []}));
        mount();
        expect(await screen.findByText("No users found.")).toBeTruthy();
    });
    it("requires cancellable inline confirmation before deleting, then refreshes the list", async () => {
        let deleted = false;
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const fetch = mockApi(async (url, init) => {
            if (init.method === "DELETE") {
                await held;
                deleted = true;
                return envelope(undefined);
            }
            return envelope({users: deleted ? users.filter(user => user.id !== 4) : users});
        });
        mount();
        await screen.findByRole("table", {name: "Users"});
        fireEvent.click(row("app-user").getByRole("button", {name: "Delete app-user"}));
        expect(row("app-user").getByText("Delete app-user? This also signs them out of all sessions.")).toBeTruthy();
        expect(fetch.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
        fireEvent.click(row("app-user").getByRole("button", {name: "Cancel"}));
        expect(screen.queryByRole("button", {name: "Confirm delete app-user"})).toBeNull();
        fireEvent.click(row("app-user").getByRole("button", {name: "Delete app-user"}));
        fireEvent.click(row("app-user").getByRole("button", {name: "Confirm delete app-user"}));
        await waitFor(() => expect(fetch.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1));
        const request = fetch.mock.calls.find(([, init]) => init?.method === "DELETE")!;
        expect(String(request[0])).toBe("/api/users/4");
        expect(disabled(screen.getByRole("button", {name: "Deleting…"}))).toBe(true);
        expect(disabled(screen.getByRole("button", {name: "Create user"}))).toBe(true);
        release();
        await screen.findByRole("table", {name: "Users"});
        await waitFor(() => expect(screen.queryByRole("row", {name: /app-user/})).toBeNull());
        expect(fetch.mock.calls.filter(([url, init]) => String(url) === "/api/users" && (!init?.method || init.method === "GET"))).toHaveLength(2);
        expect(screen.getByText("User deleted.")).toBeTruthy();
    });
    it.each(["admin", "owner"])("prevents an admin granting %s even if typed as a role", async role => {
        const fetch = mockApi();
        mount();
        await screen.findByRole("table", {name: "Users"});
        fireEvent.change(screen.getByLabelText("Username"), {target: {value: "new-user"}});
        fireEvent.change(screen.getByLabelText("Password"), {target: {value: "new-password-123"}});
        fireEvent.change(screen.getByLabelText("Roles"), {target: {value: role}});
        fireEvent.submit(screen.getByRole("form", {name: "Create user"}));
        expect((await screen.findByRole("alert")).textContent).toContain("Only owners can grant owner or admin");
        expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
        expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
    });
    it("creates an owner-selected account, clears its password, blocks duplicate submissions and refreshes users", async () => {
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        let created = false;
        const fetch = mockApi(async (url, init) => {
            if (url !== "/api/users") return envelope(undefined, 404);
            if (init.method === "POST") {
                await held;
                created = true;
                return envelope({user: {id: 5, username: "new-user", roles: ["owner", "admin", "custom-role"]}}, 201);
            }
            return envelope({users: created ? [...users, {...users[3], id: 5, username: "new-user"}] : users});
        });
        mount(["owner"], 1);
        await screen.findByRole("table", {name: "Users"});
        expect(disabled(row("other-admin").getByRole("button", {name: "Delete other-admin"}))).toBe(false);
        fireEvent.change(screen.getByLabelText("Username"), {target: {value: " new-user "}});
        fireEvent.change(screen.getByLabelText("Password"), {target: {value: "new-password-123"}});
        fireEvent.change(screen.getByLabelText("Roles"), {target: {value: "owner, admin, custom-role"}});
        const form = screen.getByRole("form", {name: "Create user"});
        fireEvent.submit(form);
        fireEvent.submit(form);
        await waitFor(() => expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1));
        expect(disabled(screen.getByRole("button", {name: "Creating user…"}))).toBe(true);
        expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
        const post = fetch.mock.calls.find(([, init]) => init?.method === "POST")!;
        expect(JSON.parse(String(post[1]?.body))).toEqual({username: "new-user", password: "new-password-123", roles: ["owner", "admin", "custom-role"]});
        expect(new Headers(post[1]?.headers).get("X-CSRF-Token")).toBe("token");
        release();
        await screen.findByRole("row", {name: /new-user/});
        expect(screen.getByText("User created.")).toBeTruthy();
    });
    it("retries a failed list request without an unhandled rejection", async () => {
        let attempts = 0;
        mockApi(url => url === "/api/users" && ++attempts === 1
            ? Promise.reject(new TypeError("offline")) : undefined);
        mount();
        expect((await screen.findByRole("alert")).textContent).toContain("Can't reach the server");
        fireEvent.click(screen.getByRole("button", {name: "Retry loading users"}));
        await screen.findByRole("table", {name: "Users"});
        expect(attempts).toBe(2);
    });
    it("lists account roles, MFA and creation date with protected and self actions disabled for admins", async () => {
        mockApi();
        mount();
        expect(screen.getByText("Loading users…")).toBeTruthy();
        await screen.findByRole("table", {name: "Users"});
        expect(row("primary-owner").getByText("owner")).toBeTruthy();
        expect(row("primary-owner").getByText("Enabled")).toBeTruthy();
        expect(row("app-user").getByText("editor")).toBeTruthy();
        expect(row("app-user").getByText("2026-01-04")).toBeTruthy();
        for (const name of ["primary-owner", "current-admin", "other-admin"]) {
            expect(disabled(row(name).getByRole("button", {name: `Delete ${name}`}))).toBe(true);
        }
        expect(disabled(row("app-user").getByRole("button", {name: "Delete app-user"}))).toBe(false);
    });
});
