// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createElement as h, memo, StrictMode, useContext, useEffect, useState, type ReactNode} from "react";
import {act, cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {MemoryRouter} from "react-router";
import {apiFetch, clearCsrfToken, configureApiClient} from "@server/client/helpers";
import {UserContext, UserProvider, useUser, type UserContextType} from "@server/client/UserProvider";
import {NavLinkRole} from "@server/client/NavLinkRole";
import {Role} from "@shared/roles";
import {SessionUserType, UserAuthState} from "@shared/types/user";

const alice: SessionUserType = {id: 1, username: "alice", roles: [Role.ADMIN]};
const bob: SessionUserType = {id: 2, username: "bob", roles: ["editor"]};

const envelope = (data: unknown, status = 200) =>
    new Response(JSON.stringify({status: status < 400 ? "success" : "error", message: "", data}), {status, headers: {"Content-Type": "application/json"}});

type Route = (init: RequestInit) => Response | Promise<Response>;

/** fetch mock keyed by path; records calls (and their AbortSignals). */
function mockApi(routes: Record<string, Route>) {
    const calls: Array<{url: string; init: RequestInit}> = [];
    let tokens = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input);
        calls.push({url, init});
        if (url === "/api/auth/csrf") return envelope({token: `t${++tokens}`});
        const route = routes[url];
        if (!route) return envelope(undefined, 404);
        return route(init);
    }));
    return {calls, count: (url: string) => calls.filter(call => call.url === url).length};
}

/** A promise you resolve later, rejecting with AbortError if the request's signal aborts. */
function deferred(init: RequestInit) {
    let resolve!: (response: Response) => void;
    const promise = new Promise<Response>((res, rej) => {
        resolve = res;
        init.signal?.addEventListener("abort", () => rej(new DOMException("Aborted", "AbortError")));
    });
    return {promise, resolve};
}

// The latest context value seen by Probe (published from an effect, not during render).
const latest: {ctx?: UserContextType} = {};
function Probe() {
    const value = useUser();
    useEffect(() => {
        latest.ctx = value;
    });
    return h("output", {"data-testid": "state"}, `${value.loading ? "loading" : "ready"}|${value.authStage}|${value.user?.username ?? "-"}`);
}
const ctx = () => latest.ctx!;

const state = () => screen.getByTestId("state").textContent;
const renderProvider = (children: ReactNode = h(Probe), strict = false) =>
    render(strict ? h(StrictMode, null, h(UserProvider, null, children)) : h(UserProvider, null, children));

describe("UserProvider", () => {
    beforeEach(() => {
        configureApiClient({baseUrl: "", csrfPath: "/api/auth/csrf"});
        clearCsrfToken();
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it("loads the session from /api/auth/me", async () => {
        mockApi({"/api/auth/me": () => envelope({user: alice, authState: UserAuthState.AUTHENTICATED})});

        renderProvider();
        expect(state()).toBe(`loading|${UserAuthState.LOGIN}|-`);

        await waitFor(() => expect(state()).toBe(`ready|${UserAuthState.AUTHENTICATED}|alice`));
    });

    it("falls back to the login stage when /me fails", async () => {
        mockApi({"/api/auth/me": () => new Response("<html>502</html>", {status: 502})});

        renderProvider();

        await waitFor(() => expect(state()).toBe(`ready|${UserAuthState.LOGIN}|-`));
    });

    it("fetches a new CSRF token for the first mutation after login (H8)", async () => {
        const api = mockApi({
            "/api/auth/me": () => envelope({authState: UserAuthState.LOGIN}),
            "/api/auth/login": () => envelope({user: alice, authState: UserAuthState.AUTHENTICATED}),
            "/api/things": () => envelope({}),
        });
        renderProvider();
        await waitFor(() => expect(state()).toMatch(/^ready/));

        // The app's login form: POST, then hand the result to the provider.
        const status = await apiFetch<{user: SessionUserType; authState: UserAuthState}>("/api/auth/login", {method: "POST", body: "{}"});
        act(() => {
            ctx().setUser(status.user);
            ctx().setAuthStage(status.authState);
        });
        await apiFetch("/api/things", {method: "POST", body: "{}"});

        const tokens = api.calls.filter(call => call.url !== "/api/auth/csrf" && call.init.method === "POST")
            .map(call => new Headers(call.init.headers).get("X-CSRF-Token"));
        expect(tokens).toEqual(["t1", "t2"]);
        expect(state()).toBe(`ready|${UserAuthState.AUTHENTICATED}|alice`);
    });

    it("logout() returns a promise, resets the state and drops the CSRF token", async () => {
        const api = mockApi({
            "/api/auth/me": () => envelope({user: alice, authState: UserAuthState.AUTHENTICATED}),
            "/api/auth/logout": () => envelope({authState: UserAuthState.LOGIN}),
            "/api/things": () => envelope({}),
        });
        renderProvider();
        await waitFor(() => expect(state()).toMatch(/alice$/));

        let result: Promise<void> | undefined;
        await act(async () => {
            result = ctx().logout();
            await result;
        });
        expect(result).toBeInstanceOf(Promise);
        expect(state()).toBe(`ready|${UserAuthState.LOGIN}|-`);

        await apiFetch("/api/things", {method: "POST", body: "{}"});
        expect(api.count("/api/auth/csrf")).toBe(2);
    });

    it("logout() clears the local state even when the request fails", async () => {
        mockApi({
            "/api/auth/me": () => envelope({user: alice, authState: UserAuthState.AUTHENTICATED}),
            "/api/auth/logout": () => new Response(null, {status: 503}),
        });
        renderProvider();
        await waitFor(() => expect(state()).toMatch(/alice$/));

        await act(() => ctx().logout());

        expect(state()).toBe(`ready|${UserAuthState.LOGIN}|-`);
    });

    it("is StrictMode-safe: the discarded /me request is aborted and can't overwrite state", async () => {
        const pending: Array<ReturnType<typeof deferred>> = [];
        const api = mockApi({"/api/auth/me": init => {
            const request = deferred(init);
            pending.push(request);
            return request.promise;
        }});

        renderProvider(h(Probe), true);
        await waitFor(() => expect(pending).toHaveLength(2));

        const [first, second] = api.calls.filter(call => call.url === "/api/auth/me");
        expect(first.init.signal!.aborted).toBe(true);
        expect(second.init.signal!.aborted).toBe(false);

        await act(async () => {
            pending[1].resolve(envelope({user: bob, authState: UserAuthState.AUTHENTICATED}));
            pending[0].resolve(envelope({user: alice, authState: UserAuthState.AUTHENTICATED}));
        });

        await waitFor(() => expect(state()).toBe(`ready|${UserAuthState.AUTHENTICATED}|bob`));
    });

    it("aborts the /me request on unmount", async () => {
        const api = mockApi({"/api/auth/me": init => deferred(init).promise});

        const {unmount} = renderProvider();
        await waitFor(() => expect(api.count("/api/auth/me")).toBe(1));
        unmount();

        expect(api.calls[0].init.signal!.aborted).toBe(true);
    });

    it("a /me response that arrives after logout does not sign the user back in", async () => {
        let me!: ReturnType<typeof deferred>;
        mockApi({
            "/api/auth/me": init => (me = deferred(init)).promise,
            "/api/auth/logout": () => envelope({authState: UserAuthState.LOGIN}),
        });
        renderProvider();
        await waitFor(() => expect(me).toBeDefined());

        await act(() => ctx().logout());
        await act(async () => me.resolve(envelope({user: alice, authState: UserAuthState.AUTHENTICATED})));

        expect(state()).toBe(`ready|${UserAuthState.LOGIN}|-`);
    });

    it("memoizes the context value across unrelated re-renders", async () => {
        mockApi({"/api/auth/me": () => envelope({user: alice, authState: UserAuthState.AUTHENTICATED})});
        const values = new Set<UserContextType>();
        const Consumer = memo(function Consumer() {
            values.add(useContext(UserContext)!);
            return null;
        });
        function Parent() {
            const [n, setN] = useState(0);
            return h(UserProvider, null, h(Consumer), h(Probe), h("button", {onClick: () => setN(n + 1)}, `renders ${n}`));
        }

        render(h(Parent));
        await waitFor(() => expect(state()).toMatch(/alice$/));
        const before = values.size;

        fireEvent.click(screen.getByRole("button"));
        fireEvent.click(screen.getByRole("button"));

        expect(screen.getByRole("button").textContent).toBe("renders 2");
        expect(values.size).toBe(before);
    });
});

describe("NavLinkRole", () => {
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    async function renderLinks(user: SessionUserType | null) {
        mockApi({"/api/auth/me": () => envelope({user, authState: user ? UserAuthState.AUTHENTICATED : UserAuthState.LOGIN})});
        render(h(MemoryRouter, null, h(UserProvider, null,
            h(Probe),
            h(NavLinkRole, {to: "/any", requiredRoles: [], children: "any"}),
            h(NavLinkRole, {to: "/default", children: "default"}),
            h(NavLinkRole, {to: "/editor", requiredRoles: ["editor"], children: "editor"}),
            h(NavLinkRole, {to: "/owner", requiredRoles: [Role.OWNER], children: "owner"}),
        )));
        await waitFor(() => expect(state()).toMatch(/^ready/));
        return screen.queryAllByRole("link").map(link => link.textContent);
    }

    it("matches hasAnyRole: [] / omitted = any signed-in user, admin = all but owner", async () => {
        expect(await renderLinks(null)).toEqual([]);
        cleanup();
        expect(await renderLinks(alice)).toEqual(["any", "default", "editor"]);
        cleanup();
        expect(await renderLinks(bob)).toEqual(["any", "default", "editor"]);
        cleanup();
        expect(await renderLinks({...bob, roles: []})).toEqual(["any", "default"]);
        cleanup();
        expect(await renderLinks({...alice, roles: [Role.OWNER]})).toEqual(["any", "default", "editor", "owner"]);
    });
});
