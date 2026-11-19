---
title: Account security
description: Manage your password, API key, MFA enrollment, and individual sessions.
sidebar:
  order: 3
---

*Framework. Signed in.* [Shared request rules](/toto-stack/http/overview/) apply. The endpoints act on the caller's own account.

## Password confirmation

Endpoints that take `password` or `currentPassword` check the caller's existing password (a string of 1–256 characters):
- A wrong password gives **403 `PASSWORD_CONFIRMATION_FAILED`**.
- Every password-confirmation attempt counts against a shared budget of **10 per actor/account and 30 per IP per 15 minutes**, successful or not. The account endpoints and `POST`/`DELETE /api/users` share these counters; switching endpoints or between session and Bearer authentication does not grant a separate budget.

### `POST /api/account/password`

Body: `{currentPassword, newPassword}`. `newPassword` is 10–256 characters.

200 `"Password updated"`. It also **revokes the user's API key** and signs out the user's **other sessions**.

### `POST /api/account/api-key`

Body: `{password}`. Issues a new API key, replacing any previous one.

200 `data: {apiKey}`. The key is `toto_` followed by 43 base64url characters. It is shown **only in this response**; only its SHA-256 hash is stored.

### `DELETE /api/account/api-key`

No body. 200 `"API key revoked"`. This endpoint does not require password confirmation.

### `POST /api/account/mfa/start`

*Session only.* Body: `{password}`.

| Response | When |
|---|---|
| 200 `data: {qrCode, key}` | Enrollment started; it lives in the session for 10 minutes. |
| 409 `MFA_ALREADY_ENABLED` | |

### `POST /api/account/mfa/verify`

*Session only.* Body: `{token}`, a string of exactly 6 digits.

| Response | When |
|---|---|
| 200 `"MFA enabled"` | MFA is on. The user's other sessions are signed out. |
| 400 `MFA_ENROLLMENT_NOT_STARTED` | No live enrollment. |
| 400 `MFA_INVALID` | Wrong code. |
| 409 `MFA_ALREADY_ENABLED` | |

Rate limits per 10 minutes: 20 per IP, 5 per account and IP, and 10 per account. These counters are shared with [login verification](/toto-stack/http/auth/). On success the IP attempt is refunded and the account+IP counter is cleared; the account-wide attempt remains counted.

### `POST /api/account/mfa/disable`

Body: `{password, token}`, the password plus a current 6-digit TOTP code.

| Response | When |
|---|---|
| 200 `"MFA disabled"` | MFA is off. The user's other sessions are signed out. |
| 400 `MFA_INVALID` | Wrong or reused code. |
| 409 `MFA_NOT_ENABLED` | |

Rate limits: password confirmation, then the same shared MFA limits as enrollment verification (20 per IP, 5 per account and IP, and 10 per account per 10 minutes). On success the IP attempt is refunded and the account+IP counter is cleared; the account-wide attempt and password-confirmation attempts remain counted.

### `POST /api/account/revoke-session`

Body: `{password, sessionID}`, the current password plus a nonempty session ID string identifying a session belonging to the caller. No TOTP code is required.

| Response | When |
|---|---|
| 200 `"Session revoked"` | Any matching session belonging to the caller was deleted; a missing or foreign session ID is a successful no-op. |


## Source

[AccountRoute](https://github.com/totoluto/toto-stack/blob/master/packages/stack/src/routes/api/account/AccountRoute.ts) and [UserService](https://github.com/totoluto/toto-stack/blob/master/packages/stack/src/libs/services/UserService.ts).
