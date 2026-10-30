# Upgrading

## Versioning policy

`toto-stack` and `create-toto-app` are released together with the **same version number**: they form a Changesets "fixed" group. A scaffolded app depends on `toto-stack@^<version of the create-toto-app that generated it>`.

While the version is **0.x**:

| Bump | Example | May contain |
|---|---|---|
| patch | 0.2.0 → 0.2.1 | Bug and security fixes, and backwards-compatible additions. No breaking changes, no schema changes. |
| minor | 0.2.x → 0.3.0 | **Breaking changes**: API, configuration, HTTP behaviour or **Prisma schema** (and anything else released with them). |

npm's caret range on a 0.x version only allows patches: `^0.2.0` means `>=0.2.0 <0.3.0`. So:
- `npm update toto-stack` brings in **patch releases only**.
- Moving to a new minor is an explicit step: `npm install toto-stack@^0.3.0`, following the notes below.

Only the latest minor line receives fixes (see [SECURITY.md](../SECURITY.md#supported-versions)). After 1.0, regular semver applies (breaking changes only in majors).

Every release has notes in the package changelogs (`packages/stack/CHANGELOG.md` and `packages/create-toto-app/CHANGELOG.md`, maintained by Changesets and shipped in both npm packages) and on the GitHub releases page. Breaking changes and schema changes are called out there.

## What updates and what doesn't

| Part of your app | Where it comes from | How it updates |
|---|---|---|
| Server framework: auth, sessions, CSRF, rate limits, the built-in routes (`/api/auth`, `/api/account`, `/api/users`, `/api/health`), `toto-stack/client` (`apiFetch`, `UserProvider`, `NavLinkRole`) | the `toto-stack` package | Version bump, as above |
| Prisma models (`User`, `Role`, `UserRole`, `Session`, `SetupLock`) | **copied** into your `schema.prisma` | Manually; see [Schema changes](#schema-changes) |
| Client UI (login, MFA and setup screens, layout, styles), `server/index.ts`, the app's routes in `server/routes` (`/api/notifications`, `/api/status`), Dockerfile, compose files, `sample.env`, scripts | **copied** once by `create-toto-app` | Not automatically; port the changes you want |

To see what changed in the template between two releases, diff `packages/create-toto-app/template` between the two release tags (`create-toto-app@<version>`), e.g. `git diff create-toto-app@0.1.0 create-toto-app@0.2.0 -- packages/create-toto-app/template`. Alternatively, scaffold a throwaway app with the new version (`npm create toto-app@<version> tmp-app`) and compare it with yours.

## User management is now built in

`/api/users` is maintained by `toto-stack` and mounted before app routes. Existing apps should remove the `UsersRoute` import and registration from `server/routes/index.ts`, then remove the copied `server/routes/UsersRoute.ts`. No Prisma migration is needed. If you customized that route, review the changes: a copied route at the same path no longer overrides the core endpoints. Put app-specific extensions on distinct paths rather than relying on the old template route.

## Upgrade checklist (minor versions)

1. Read the changelog entries between your version and the target. Note breaking changes, new configuration and schema changes.
2. Bump the package: `npm install toto-stack@^<new minor>`.
3. Apply any [schema changes](#schema-changes).
4. Run `npm run typecheck`. Changed APIs and a schema that no longer matches `StackPrismaClient` both show up as type errors.
5. Start the app in development. If the configuration is invalid, a `ConfigError` lists every problem.
6. Port template changes you want: UI fixes, Dockerfile, compose files.
7. Deploy. The template's `migrate` service applies migrations before the new app starts.

## Schema changes

0.1.0 ships one initial migration (`0_init`) for the complete schema. From then on, a minor release may change the models in `toto-stack/prisma/base.prisma`, for example by adding a column or an index. The new code expects the new schema, so the migration and the code change ship together.

1. **Compare the models.** The changelog lists the schema changes. You can also diff `node_modules/toto-stack/prisma/base.prisma` of the old and new versions, for example by keeping a copy before upgrading.
2. **Apply the changes** to the stack's models in your `prisma/schema.prisma`, keeping your own columns, relations and models.
3. **Create a migration** in development:

   ```bash
   npx prisma migrate dev --name toto-stack-<version>
   npx prisma generate
   ```

   Review the generated SQL before committing it. Watch for:
   - new `NOT NULL` columns on tables that already have rows (they need a default or a data step);
   - dropped or renamed columns (Prisma drops and re-adds a renamed column unless you edit the SQL);
   - long-running index builds on large tables.
4. **Commit** the migration directory together with the dependency bump.
5. **Deploy.** `prisma migrate deploy` runs the migration before the new app version starts (the `migrate` service, or `npm run db:deploy`). Prisma migrations only go forward: back up the database first, and roll back by restoring the backup or with a new migration.

If you run several instances with rolling deploys, old app instances run against the new schema for a moment. Additive changes (new nullable columns, new tables, new indexes) are safe. The release notes say when a change isn't.

## Keeping the dependency overrides

Generated apps carry npm `overrides` (`mariadb`, `mysql2`, `deepmerge-ts`) that replace vulnerable versions pinned by `@prisma/adapter-mariadb@7.10.0`.

- Keep them until a Prisma 7 release updates its pin.
- Check with `npm ls mariadb` and `npm audit --omit=dev`.
- npm honours `overrides` only in the root `package.json` of the project being installed, which is why the monorepo's own overrides don't reach your app.

## Toolchain versions

- **Node.js:** `>=22.12`. CI tests 22.12.0, the latest 22.x, 24.x and 26.x.
- **Prisma:** 7.x. Prisma 8 is not supported yet. Keep `prisma` and `@prisma/client` on `^7`; npm's `latest` tag for `prisma` points to 8.x pre-releases.
- **React** 18/19 and **react-router** 7/8 for `toto-stack/client`.
