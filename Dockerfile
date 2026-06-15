# syntax=docker/dockerfile:1.24.0@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89

FROM node:24.16.0-alpine@sha256:fb71d01345f11b708a3553c66e7c74074f2d506400ea81973343d915cb64eef0 AS base
# renovate: datasource=npm depName=pnpm
# Must match package.json "packageManager" exactly — otherwise corepack will
# auto-fetch the package.json-pinned version at container start (which fails
# with ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY in non-TTY runtimes).
ARG PNPM_VERSION=11.6.0
RUN corepack enable && corepack prepare pnpm@$PNPM_VERSION --activate
WORKDIR /app

# --- deps stage: install all deps (including dev) for build ---
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# --- build stage: compile Next.js, generate Prisma client, prune devDeps ---
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build pnpm db:generate

# Declare GIT_SHA AFTER deps + db:generate so layer cache for those stays warm.
# The default 'unknown' applies to local `docker build` without --build-arg;
# CI passes the real value. NEXT_PUBLIC_* gets inlined into the JS bundle.
ARG GIT_SHA=unknown
ENV NEXT_PUBLIC_GIT_SHA=$GIT_SHA

# Sentry (optional — non-secret DSNs as ARG/ENV; auth token via --secret mount).
# The DSNs are public values that ship in the bundle anyway (NEXT_PUBLIC_*) or
# only identify a project, so ARG/ENV is fine. SENTRY_AUTH_TOKEN is a write
# token to the Sentry project — buildkit's SecretsUsedInArgOrEnv lint
# correctly flagged using ARG/ENV for it (the value would land in image
# history). We mount it inline on the build RUN below so it's available as an
# env var ONLY during that step and never persisted in any layer.
ARG SENTRY_DSN
ARG NEXT_PUBLIC_SENTRY_DSN
ENV SENTRY_DSN=$SENTRY_DSN
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN
ENV LOG_LEVEL=info

# To enable source-map upload during build, pass:
#   docker build --secret id=sentry_auth_token,src=/path/to/token ...
# When the secret is absent, buildkit just doesn't set the env var, so
# withSentryConfig's authToken is undefined and source-map upload no-ops.
RUN --mount=type=secret,id=sentry_auth_token,env=SENTRY_AUTH_TOKEN \
    DATABASE_URL=postgresql://build:build@localhost:5432/build \
    AUTH_SECRET=buildsecretbuildsecretbuildsecretbuild \
    AUTH_OIDC_ISSUER=https://auth.example.com \
    AUTH_OIDC_CLIENT_ID=build \
    AUTH_OIDC_CLIENT_SECRET=build \
    MEILI_HOST=http://localhost:7700 \
    MEILI_KEY=build \
    FILES_DIR=/tmp/files \
    WEB_PUSH_VAPID_PUBLIC_KEY=build-vapid-public-key-placeholder \
    WEB_PUSH_VAPID_PRIVATE_KEY=build-vapid-private-key-placeholder \
    WEB_PUSH_CONTACT_EMAIL=mailto:build@example.com \
    FORWARDEMAIL_API_KEY=build-forwardemail-key \
    FORWARDEMAIL_FROM_ADDRESS=build@example.com \
    ANTHROPIC_API_KEY=placeholder-build-time \
    pnpm build
RUN pnpm prune --prod

# --- runtime stage: minimal, prod-only deps + source files for tsx worker ---
FROM node:24.16.0-alpine@sha256:fb71d01345f11b708a3553c66e7c74074f2d506400ea81973343d915cb64eef0 AS runtime
# renovate: datasource=npm depName=pnpm
# Keep in sync with the base stage and package.json "packageManager" — see
# comment on the base stage's PNPM_VERSION arg.
ARG PNPM_VERSION=11.6.0
RUN corepack enable && corepack prepare pnpm@$PNPM_VERSION --activate
# apk pins: Alpine 3.23, Renovate-tracked via Repology (see renovate.json)
# postgresql18-client provides pg_dump for the worker's nightly DB backup job
# (worker/jobs/pg-dump.ts). pg_dump must be >= the server major; server is
# pgvector:pg18, matched.
RUN apk add --no-cache \
  curl=8.20.0-r1 \
  postgresql18-client=18.4-r0 \
  vips=8.18.2-r0 \
  vips-heif=8.18.2-r0
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Production node_modules from build stage (after prune)
COPY --from=build /app/node_modules ./node_modules

# Next.js build output
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public

# Prisma schema, migrations, and config (needed for prisma migrate deploy at startup)
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./prisma.config.ts

# Worker source (run via tsx, no compile step)
COPY --from=build /app/worker ./worker
COPY --from=build /app/lib ./lib
COPY --from=build /app/auth.config.ts ./auth.config.ts
COPY --from=build /app/tsconfig.json ./tsconfig.json

# Manifests
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/pnpm-workspace.yaml ./pnpm-workspace.yaml

# Re-declare GIT_SHA in this stage; placed AFTER all COPYs so only this final
# tiny layer rebuilds per commit (the COPY layers stay cached as long as the
# build stage's outputs are unchanged for the same SHA).
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA

# Static OCI labels (the dynamic ones — revision, version, created — are
# applied at the manifest level by docker/metadata-action in CI).
LABEL org.opencontainers.image.title="house-manager" \
      org.opencontainers.image.description="Self-hosted PWA for household record-keeping." \
      org.opencontainers.image.authors="Oliver Wine <ow@mroliverwine.com>" \
      org.opencontainers.image.vendor="owine" \
      org.opencontainers.image.source="https://github.com/owine/house-manager" \
      org.opencontainers.image.documentation="https://github.com/owine/house-manager#readme" \
      org.opencontainers.image.revision=$GIT_SHA

EXPOSE 3000

# Healthcheck is defined per-service in docker-compose.yml (web only).
# This image is used by both web and worker; the worker has no HTTP surface
# so it doesn't get a healthcheck.

CMD ["pnpm", "start"]
