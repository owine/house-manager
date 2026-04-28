# syntax=docker/dockerfile:1.23

FROM node:24.15.0-alpine AS base
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
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build \
    AUTH_SECRET=buildsecretbuildsecretbuildsecretbuild \
    AUTH_OIDC_ISSUER=https://auth.example.com \
    AUTH_OIDC_CLIENT_ID=build \
    AUTH_OIDC_CLIENT_SECRET=build \
    MEILI_HOST=http://localhost:7700 \
    MEILI_KEY=build \
    FILES_DIR=/tmp/files \
    pnpm build
RUN pnpm prune --prod

# --- runtime stage: minimal, prod-only deps + source files for tsx worker ---
FROM node:24.15.0-alpine AS runtime
RUN corepack enable && apk add --no-cache curl
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

EXPOSE 3000

# Healthcheck is defined per-service in docker-compose.yml (web only).
# This image is used by both web and worker; the worker has no HTTP surface
# so it doesn't get a healthcheck.

CMD ["pnpm", "start"]
