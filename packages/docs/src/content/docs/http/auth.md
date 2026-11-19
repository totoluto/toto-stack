---
title: Authentication
description: CSRF tokens, auth states, password login, MFA verification, logout, and first-owner setup.
sidebar:
  order: 2
---

## Auth state

`data` of login, login verification, setup completion, logout and `/me` responses uses `UserStatusType`. Setup start returns enrollment data instead; see its endpoint below:

```json
{"user": {"id": 1, "username": "alice", "roles": ["owner"]}, "authState": "authenticated"}
```

| `authState` | Meaning | Next step |
|---|---|---|
| `setup` | No user exists yet | `POST /api/auth/setup/start` |
| `setup-verify` | Setup started; waiting for the TOTP code | `POST /api/auth/setup/verify` |
| `login` | Not signed in (also: wrong credentials) | `POST /api/auth/login` |
| `otp` | Password accepted; waiting for the TOTP code (also: wrong code) | `POST /api/auth/login/verify` |
| `authenticated` | Signed in; `user` is set | |

`user` is `null` in every state except `authenticated`.

## Endpoints

All endpoints on this page are framework-owned. [Shared request rules](/toto-stack/http/overview/) apply, including CSRF for public session mutations.

### `GET /api/auth/csrf`

*Public.* Rate limit: 120 per minute per IP.

Returns a CSRF token for the `X-CSRF-Token` header: `data: {token}`.
- **Anonymous visitors** get a stateless signed token. It is bound to an HttpOnly, SameSite=Strict nonce cookie (`__Host-connect.sid.csrf` in production) and is valid for 12 hours. Nothing is written to the database.
- **Signed-in sessions** get the session's own token.

Fetch a new token after every login, MFA completion, setup or logout, because the session changes. `apiFetch` and `UserProvider` do this automatically.

### `GET /api/auth/me`

*Public.* The caller's auth state.
- Before setup it answers `setup` (or `setup-verify` while a setup is in progress in this session).
- During an MFA login it answers `otp`.
- Otherwise it answers `authenticated` with the user (roles are read from the database) or `login`.
- With a Bearer header it reports only the key's user (`authenticated`) or `login`.

### `POST /api/auth/login`

*Public, session only.* Body:

| Field | Type |
|---|---|
| `username` | string, 1–64 characters (trimmed) |
| `password` | string, 1–256 characters |

Response 200 with an auth state:
- **`login`:** wrong username or password. The response is identical, and takes the same time, for unknown users.
- **`otp`:** the password is correct and MFA is enabled. The session gets a new id and holds the pending login for 10 minutes.
- **`authenticated`:** signed in. The session gets a new id, and the browser gets a **device cookie** (below).

A new login replaces any pending MFA login or setup of the session.

Rate limits, per 15 minutes:
- 20 attempts per IP (IPv6 per /56).
- 5 per account and IP.
- 100 per account from any IP. A browser with a valid device cookie for this account skips this ceiling and is limited to **10 per device** instead.

A correct password doesn't count: it refunds the IP and the account (or device) attempt and clears the account+IP counter.

A successful login verification refunds its IP attempt and clears the account+IP MFA counter, but does not refund the account-wide MFA attempt.

**Device cookie.** After a complete sign-in (password plus MFA if enabled, or setup), the response sets `__Host-<cookieName>.device` (`connect.sid.device` in development).
- It is signed, HttpOnly and SameSite=Strict, and valid for 180 days. It names the account by a hash and holds a random device id.
- It grants no access. It only lets a user log in from a browser they used before, even while attackers elsewhere exhaust the account-wide ceiling.
- Only the most recently signed-in account per browser is remembered.

### `POST /api/auth/login/verify`

*Public, session only.* Body: `{token}` (6 digits).

| Response | When |
|---|---|
| 200 `authenticated` | Code correct. The session gets a new id, and the browser gets the device cookie. |
| 200 `otp` | Wrong, expired or already used code; try again. |
| 200 `login` | The account was deleted, no longer has MFA, or **its password changed** since the password step; the pending login is discarded. |
| 401 `MFA_NOT_PENDING` | No live pending login (expired after 10 minutes, or never started). Log in again. |

Rate limits, per 10 minutes:
- 20 per IP.
- 5 per account and IP.
- 10 per account.

### `POST /api/auth/logout`

*Public, session only.* Body: none or `{}`.

Always answers 200 `login`. It ends an authenticated session, a pending MFA login, setup, or MFA enrollment, clearing the session cookie when such state exists. Anonymous calls cause no database write.

### `POST /api/auth/setup/start`

*Public, session only.* First-run setup of the owner account. Body:

| Field | Type |
|---|---|
| `username` | string, 1–64 characters (trimmed) |
| `password` | string, 10–256 characters |
| `setupToken` | string, 1–512 characters: `SETUP_TOKEN`, or the token from the server log |

| Response | When |
|---|---|
| 200 `data: {authState: "setup-verify", qrCode, key}` | Token accepted. `qrCode` is a PNG data URL of the `otpauth://` URI; `key` is the base32 secret for manual entry. The pending setup lives in a new session for 10 minutes. |
| 403 `SETUP_COMPLETED` | Setup is already complete (a user already exists). |
| 403 `SETUP_TOKEN_INVALID` | Wrong token. |

Rate limit: 5 attempts per IP (IPv6 per /56) per 15 minutes. An accepted token refunds its attempt.

### `POST /api/auth/setup/verify`

*Public, session only.* Body: `{token}` (6 digits from the authenticator app).

| Response | When |
|---|---|
| 200 `authenticated` | Code correct. The owner is created with MFA enabled and signed in on a new session, and the browser gets the device cookie. |
| 200 `setup-verify` | Wrong code; try again. |
| 400 `SETUP_NOT_STARTED` | No live setup in this session (expired after 10 minutes, or never started). |
| 403 `SETUP_COMPLETED` | Another setup won the race, or setup is already complete. |
| 403 `SETUP_TOKEN_CHANGED` | The active setup token changed since `/setup/start`, for example a restart with a generated token. Start again. |

Rate limit: 5 attempts per IP per 10 minutes. The owner is created atomically, so concurrent setups yield exactly one owner.


## Source

[Auth route classes](https://github.com/totoluto/toto-stack/blob/master/packages/stack/src/routes/api/auth) and [AuthService](https://github.com/totoluto/toto-stack/blob/master/packages/stack/src/libs/security/AuthService.ts).
