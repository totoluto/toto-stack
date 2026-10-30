---
"toto-stack": minor
"create-toto-app": minor
---

Promote user management to a built-in API: `GET`/`POST /api/users` and `DELETE /api/users/:id` are now mounted by the framework without app routes. Preserve admin/owner authorization, protected accounts, strict creation validation and secret-free responses. Reject malformed or out-of-range deletion IDs before database access, and load only identity and roles for deletion authorization.

Existing apps should remove their copied `UsersRoute.ts` and its registration from `server/routes/index.ts`; framework endpoints take precedence over app routes at the same paths. Review any local customizations and move app-specific extensions to distinct paths. No Prisma migration is required.
