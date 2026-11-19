---
title: Client
description: Use React auth context, CSRF-aware API requests, role-aware links, and shared types.
sidebar:
  order: 5
---

Browser-safe React building blocks (no server code). Peer dependencies: `react` 18/19 and `react-router` 7/8.

```tsx
import {createRoot} from "react-dom/client";
import {BrowserRouter} from "react-router";
import {NavLinkRole, Role, UserAuthState, UserProvider, useUser} from "toto-stack/client";

function AccountNavigation() {
    const {user, authStage, loading, logout} = useUser();
    if (loading) return <p>Loading…</p>;
    if (authStage !== UserAuthState.AUTHENTICATED || !user) {
        return <p>Please sign in.</p>;
    }

    return (
        <nav>
            <span>{user.username}</span>
            <NavLinkRole to="/admin" requiredRoles={[Role.ADMIN]}>Admin</NavLinkRole>
            <button onClick={() => void logout()}>Log out</button>
        </nav>
    );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element");

createRoot(root).render(
    <BrowserRouter>
        <UserProvider><AccountNavigation /></UserProvider>
    </BrowserRouter>,
);
```

This example displays auth state; it does not implement the setup or sign-in screens. Keep those from the generated app or implement the [authentication flow](/toto-stack/guides/authentication/).

## Make API requests

```ts
import {apiFetch, ApiError, ErrorCode, type UserStatusType} from "toto-stack/client";

try {
    const status = await apiFetch<UserStatusType>("/api/auth/me");
    console.log(status);
} catch (error) {
    if (error instanceof ApiError && error.code === ErrorCode.RATE_LIMITED) {
        console.warn("Too many requests; retry later.");
    } else {
        throw error;
    }
}
```

For mutations, pass `method` and `body: JSON.stringify(payload)`. `apiFetch` supplies cookies, content type, and CSRF. Use it only for your trusted API: credentials and CSRF headers must not be sent to arbitrary destinations.


## `apiFetch(url, options?)`

`fetch` for the toto-stack API. It resolves to the envelope's `data`, or `undefined` for 204 and empty responses.
- **Cookies and CSRF:** it sends cookies (`credentials: "include"`). For unsafe methods it attaches `X-CSRF-Token`. The token is fetched once and shared by concurrent requests, and a 403 with code `CSRF_INVALID` is retried once with a fresh token (not for streamed bodies).
- **Content-Type:** string bodies are sent as `application/json` unless you set a Content-Type. `FormData`, `Blob` and `URLSearchParams` keep the browser's.
- **`options.parse`** validates the response, for example a zod schema's `parse`. Without it, the type argument is an unchecked assertion.
- **Errors:** every failure response rejects with an **`ApiError`** carrying `status`, `code` (typed `ApiErrorCode`: one of the stack's `ErrorCode`s, including the client-side `INVALID_RESPONSE`, or your routes' own codes) and `details`. A non-JSON body (for example a proxy error page) gets `code: "INVALID_RESPONSE"`. Network errors and aborts propagate unchanged (`TypeError`/`AbortError`).

## Other exports

- **`configureApiClient({baseUrl?, csrfPath?})`:** for an API on another origin, or a different CSRF path. Call it once at startup.
- **`clearCsrfToken()`:** drops the cached token. Call it whenever the session changes outside `UserProvider`.
- **`UserProvider` / `useUser()`:** `{user, loading, authStage, setUser, setAuthStage, logout}`.
  - It loads `GET /api/auth/me` on mount. A failure leaves you signed out (`authStage: "login"`).
  - `setUser` and `setAuthStage` also drop the cached CSRF token, because the server issues a new session on login, MFA and setup.
  - `logout(): Promise<void>` posts `/api/auth/logout` and resets the local state, even if the request fails.
  - A 401 or `authStage: "login"` after an absolute or idle timeout means the session ended.
- **`NavLinkRole`:** a react-router `NavLink` rendered only for signed-in users matching `requiredRoles`. Same semantics as `hasAnyRole`; `[]` or omitted means any signed-in user.
- **Re-exports:** also exported are `Role`, `BUILTIN_ROLES`, `hasAnyRole`, `canGrantRole`, `UserAuthState`, `ErrorCode`, and the types `SessionUserType`, `UserStatusType`, `WebResponse`, `WebErrorResponse`, `BuiltinRole`, `ApiClientOptions`, `ApiFetchOptions`, `ApiErrorCode` and `UserContextType`.

Visibility is not access control: `NavLinkRole` only hides links. The server enforces roles.

## Framework-free shared entry

Client-safe constants and types, with no Node or React dependencies: `Role`, `BUILTIN_ROLES`, `hasAnyRole`, `canGrantRole`, `UserAuthState` (`authenticated`, `login`, `otp`, `setup`, `setup-verify`), `ErrorCode`, `SessionUserType`, `UserStatusType`, `PrismaUserType`, `PrismaRoleType`, `WebResponse` and `WebErrorResponse`.

```ts
import {hasAnyRole, Role, type SessionUserType} from "toto-stack/shared";

export const canModerate = (user: SessionUserType | null) => hasAnyRole(user?.roles, [Role.ADMIN, "moderator"]);
```

The three entries share one module instance, so `Role` from `toto-stack` and from `toto-stack/shared` are the same object.

## Generated settings UI

The generated app's `/admin/settings` supports `?section=account`, `security`, `users`, `notifications`, and `service`. Users and notifications sections are for admins and owners. The UI changes account credentials and MFA, manages eligible users, sends to explicitly chosen notification handlers, and performs on-demand readiness checks. It does not edit server configuration or list sessions.

The readiness endpoint `/api/health` returns a plain object, **not** the normal response envelope. Use native `fetch` and check its HTTP status when consuming it; do not expect `apiFetch` to return readiness data. A 503 is a degraded check, not success.

## Serve the browser and API together

The generated Vite dev server proxies `/api`, and production serves the built SPA from the backend. This keeps cookies same-site. Configuring a different `baseUrl` does not override cookie `SameSite` rules or the server's origin allowlist. See [Configuration](/toto-stack/operate/configuration/) and [Troubleshooting](/toto-stack/maintain/troubleshooting/#login-cookies-and-csrf).

Full request/response contracts are in the [HTTP reference](/toto-stack/http/overview/); exported component and helper signatures are in the [TypeScript API](/toto-stack/api/).
