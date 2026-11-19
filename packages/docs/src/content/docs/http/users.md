---
title: User management
description: Admin and owner user listing, creation, deletion, password confirmation, and role restrictions.
sidebar:
  order: 4
---

*Framework. Admin.* [Shared request rules](/toto-stack/http/overview/) apply. Always mounted, even without app routes. Only owners may grant `owner` or `admin`; admins may grant configured app roles. Creating a user follows the stack's password policy (`createUserSchema`), and `userService.createUser` turns a taken username into a 409. Password, MFA and API-key changes belong to the signed-in user's `/api/account` endpoints; this API does not expose credential resets or role updates.

**Password confirmation for mutations.** Both `POST /api/users` and `DELETE /api/users/:id` require `currentPassword`: the authenticated actor's existing password, not the new or target user's password. It must be a string of 1–256 characters. This applies to both cookie sessions and Bearer API keys; a key alone never authorizes a mutation. A missing or invalid field gives **400 `VALIDATION_FAILED`**; a wrong actor password gives **403 `PASSWORD_CONFIRMATION_FAILED`**.

Every password-confirmation attempt counts, successful or not, against the [shared account/users budget](/toto-stack/http/account/#password-confirmation): **10 per actor/account and 30 per IP per 15 minutes**. Exceeding it gives **429 `RATE_LIMITED`** with `Retry-After` (seconds). Global limits, role checks and CSRF rules are unchanged: cookie-session mutations still need `X-CSRF-Token`; Bearer requests remain exempt from CSRF, not from password confirmation.

### `GET /api/users`

200 `data: {users: [{id, username, otpEnabled, createdAt, roles}]}`.

### `POST /api/users`

Body:

| Field | Type |
|---|---|
| `username` | string, 1–64 characters (trimmed) |
| `password` | string, 10–256 characters: the new user's password |
| `currentPassword` | string, 1–256 characters: the authenticated actor's existing password |
| `roles` | optional array of configured role names (built-in plus `roles` from the config); at most 64 entries, duplicates removed; default `[]` |

**Additional creation limit:** **5 attempts per actor and 20 per IP per 15 minutes**. Every schema-valid, role-authorized create attempt counts, including duplicate usernames and wrong actor passwords. This limit is checked before actor-password verification or hashing the new user's password. It is separate from the shared password-confirmation budget; exceeding either limit gives **429 `RATE_LIMITED`** with `Retry-After` (seconds).

| Response | When |
|---|---|
| 201 `data: {user: {id, username, roles}}` | Created, without MFA and without an API key. Users issue their own key. |
| 400 `VALIDATION_FAILED` | Invalid body, including missing `currentPassword`, or an unknown role. |
| 403 `PASSWORD_CONFIRMATION_FAILED` | Wrong actor password. |
| 403 `ROLE_NOT_GRANTABLE` | Only an owner may grant `owner` or `admin`. |
| 409 `USERNAME_TAKEN` | Also returned for a concurrent duplicate. |
| 429 `RATE_LIMITED` | Creation or shared password-confirmation budget exceeded; includes `Retry-After`. |

### `DELETE /api/users/:id`

Body (strict JSON): `{currentPassword}`. `currentPassword` is the authenticated actor's existing password, a string of 1–256 characters; unknown fields are rejected.

| Response | When |
|---|---|
| 200 `"User deleted"` | The user's sessions are deleted with them. |
| 400 `VALIDATION_FAILED` | Missing or invalid `currentPassword`, or an unknown body field. |
| 400 `INVALID_USER_ID` | Not a canonical positive decimal integer in the Prisma `Int` range (1–2147483647). |
| 400 `CANNOT_DELETE_SELF` | |
| 403 `PASSWORD_CONFIRMATION_FAILED` | Wrong actor password. |
| 403 `USER_PROTECTED` | The target is an owner, or holds a role the caller may not grant (an admin deleting an admin). |
| 404 `USER_NOT_FOUND` | Also when the user was deleted concurrently. |
| 429 `RATE_LIMITED` | Shared password-confirmation budget exceeded; includes `Retry-After`. |


## Source

[UsersRoute](https://github.com/totoluto/toto-stack/blob/master/packages/stack/src/routes/api/user/UsersRoute.ts).
