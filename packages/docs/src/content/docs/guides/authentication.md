---
title: Authentication
description: Integrate owner setup, password and MFA sign-in, sessions, API keys, and roles.
sidebar:
  order: 2
---

The package provides the complete sign-in flow and account-security endpoints. The generated client already connects them; custom clients should follow the server's auth state rather than inferring success from an HTTP 200.

## Complete first-run setup

1. Read `GET /api/auth/me`. A fresh instance reports the `setup` state.
2. Submit `POST /api/auth/setup/start` with `{username, password, setupToken}`. Use `SETUP_TOKEN` from your environment, or the one-time token printed to stderr when no user exists.
3. Show the returned authenticator enrollment and submit a current code to `POST /api/auth/setup/verify` as `{token}`.

The first account is the owner and enrolls MFA as part of setup. A database transaction and singleton setup lock prevent two concurrent requests from claiming ownership. Pending setup expires after 10 minutes. If the setup token changes, restart the flow; `SETUP_TOKEN_CHANGED` rejects the old pending setup.

Complete setup immediately after deploying. For multiple instances, configure the same `SETUP_TOKEN` rather than relying on per-process generated tokens.

## Sign in and maintain client state

`POST /api/auth/login` accepts username and password. Its response `authState` is `login` for incorrect credentials, `otp` when MFA is pending, or `authenticated` on success. A wrong password is a **200 response with `authState: "login"`**, not an HTTP error.

For MFA, submit `{token}` to `POST /api/auth/login/verify`. An incorrect code leaves the response in `otp`; successful verification completes sign-in. Codes are six digits with 30-second steps and a one-step drift allowance. A previously accepted code cannot be reused. Pending MFA expires after 10 minutes.

Use [UserProvider and apiFetch](/toto-stack/guides/client/) to track state and refresh CSRF tokens after session changes. Custom clients must send cookies, fetch `GET /api/auth/csrf`, and attach its token as `X-CSRF-Token` on unsafe methods, including login and setup. Refetch after login, MFA, setup, or logout.

The shared `UserAuthState` values are `authenticated`, `login`, `otp`, `setup`, and `setup-verify`. Full payloads and response shapes belong to the [HTTP reference](/toto-stack/http/overview/).

## Manage account security

The generated **Settings** page supports password changes, MFA enrollment and disabling, API-key issuance/revocation, and revocation of a known session ID. It does not invent an MFA-status value or session list: the API exposes neither.

- New passwords are 10–256 characters and stored with Argon2id. Sensitive account changes require the current password.
- Password changes revoke the user's API key and other authenticated sessions. Old pending MFA logins cannot complete with a changed password.
- Enabling or disabling MFA revokes other authenticated sessions; disabling requires both the password and a current code.
- Logout destroys the current session. Absolute and idle timeouts end sessions server-side, even if a browser retains a cookie.

Defaults are a seven-day absolute lifetime and a 24-hour idle lifetime; activity writes are throttled. See [session configuration](/toto-stack/operate/configuration/#sessions) for precision and cookie behavior.

There is **no password reset, email verification, or MFA recovery-code flow**. Back up the owner's authenticator access. Lost authenticators need [operator intervention](/toto-stack/maintain/troubleshooting/#a-user-lost-their-authenticator).

## Authenticate automation with API keys

A signed-in user issues a key through `POST /api/account/api-key`, confirming their password. The plaintext key is returned only once; only its SHA-256 hash is stored. Issuing another key replaces the old one.

Send it as `Authorization: Bearer <api-key>`. Bearer requests ignore session cookies, have no session fallback on failure, and skip CSRF. Session-oriented endpoints such as login, setup, logout, and MFA enrollment reject Bearer authentication with `BEARER_NOT_ALLOWED`.

Keys act with the user's current roles, without MFA, scopes, or expiry. Revoke with `DELETE /api/account/api-key`; password changes and user deletion revoke keys too. Keep keys in a secret store and out of URLs and logs.

## Roles

```ts
import {createServer, Role} from "toto-stack";
import {prisma} from "./prisma.js";

export const AppRole = {...Role, EDITOR: "editor", VIEWER: "viewer"} as const;
createServer({prisma, roles: [AppRole.EDITOR, AppRole.VIEWER]});
```

Role names are trimmed, 1–64 characters, and synchronized add-only at boot. Removing a configured role does not delete it from the database.

- `owner` satisfies every role requirement.
- `admin` satisfies every requirement except `owner`-only requirements.
- App roles satisfy themselves. A list means **any** matching role, not all.
- An empty or omitted role list means any signed-in user.

Use route guards for enforcement; `hasAnyRole` and `NavLinkRole` share these semantics, but hidden links are not authorization. Users and their role names are loaded from the database for every authenticated request.

## Manage users

Built-in `/api/users` endpoints allow admins and owners to list, create, and delete eligible users. Creation and deletion require the **acting user's `currentPassword`**, even with a Bearer key.

Only owners may grant `owner` or `admin`; admins may grant app roles. Deletion requires the ability to grant every role held by the target. Owners and your own account cannot be deleted through this API. Use `canGrantRole` in any custom role-assignment workflow too.

There is no endpoint for changing an existing user's roles. Change them through an operator-controlled database process or delete and recreate an eligible user. Review [authorization and rate limits](/toto-stack/operate/security/#authorization) before implementing alternative administration routes.
