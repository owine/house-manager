# syntax=docker/dockerfile:1.23.0@sha256:2780b5c3bab67f1f76c781860de469442999ed1a0d7992a5efdf2cffc0e3d769

FROM node:24.15.0-alpine@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f AS base
RUN corepack enable
WORKDIR /app

# --- deps stage: install all deps (including dev) for build ---
FROM base AS deps
COPY package.json pnpm-lock.yaml .npmrc ./
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

# Sentry (optional — source-map upload during build, runtime DSN reporting)
ARG SENTRY_DSN
ARG NEXT_PUBLIC_SENTRY_DSN
ARG SENTRY_AUTH_TOKEN
ENV SENTRY_DSN=$SENTRY_DSN
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN
ENV SENTRY_AUTH_TOKEN=$SENTRY_AUTH_TOKEN
ENV LOG_LEVEL=info

RUN DATABASE_URL=postgresql://build:build@localhost:5432/build \
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
FROM node:24.15.0-alpine@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f AS runtime
RUN corepack enable && apk add --no-cache curl vips vips-heif
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
COPY --from=build /app/.npmrc ./.npmrc

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
