# syntax=docker/dockerfile:1

# Pinned base image for reproducible builds. Kept as a literal tag (not a
# build arg) so Dependabot's docker ecosystem can propose updates; change it
# here to use another Node version. Optionally pin a digest too:
# node:24.21.0-alpine3.24@sha256:...
FROM node:26.12.0-alpine3.24 AS base

# ---- deps: full dependency tree (build tools + Prisma CLI) ----
FROM base AS deps
WORKDIR /app
# Prisma's schema engine (used by `prisma migrate`) links against OpenSSL.
RUN apk add --no-cache openssl
# The schema, config and scripts/generate.js are needed by the `postinstall`
# hook (`prisma generate`, which does not need a database).
COPY package.json package-lock.json* ./
COPY prisma ./prisma
COPY prisma.config.ts ./
COPY scripts/generate.js ./scripts/
# Reproducible `npm ci` when a lockfile is committed (recommended). Without
# one, fall back to `npm install` so a fresh scaffold still builds.
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; \
    else echo "warning: no package-lock.json, dependency versions are not pinned" >&2 && npm install --no-audit --no-fund; fi

# ---- build: client bundle + server bundle (dist/) ----
FROM deps AS build
COPY . .
RUN npm run build

# ---- prod-deps: runtime dependencies only ----
FROM base AS prod-deps
WORKDIR /app
COPY package.json package-lock.json* ./
# Only toto-stack, the MariaDB adapter and their deps (~35 MB): the Prisma
# client + runtime are bundled into dist/server.js, so @prisma/client and the
# prisma CLI are devDependencies. --ignore-scripts skips the postinstall
# (it would only print that the Prisma CLI isn't installed).
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --ignore-scripts --no-audit --no-fund; \
    else npm install --omit=dev --ignore-scripts --no-audit --no-fund; fi \
    && npm cache clean --force

# ---- migrate: one-shot `prisma migrate deploy` (compose service `migrate`) ----
# Kept out of the runtime image so production containers carry no Prisma CLI,
# schema engine or dev dependencies.
FROM deps AS migrate
USER node
ENTRYPOINT ["./node_modules/.bin/prisma"]
CMD ["migrate", "deploy"]

# ---- runtime: production server (default target) ----
FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000
# Files stay root-owned (read-only for the app user).
COPY --from=prod-deps /app/package.json ./package.json
COPY --from=prod-deps /app/node_modules ./node_modules
# dist/ holds server.js and public/ (the built client).
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/api/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/server.js"]
