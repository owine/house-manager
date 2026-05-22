# Derived Playwright image for the visual regression run.
#
# Bakes linux-native node_modules + the generated Prisma client into /work so
# the container can `pnpm exec playwright test` against the host dev server
# without npm-resolving or compiling anything at test time. The host bind-mount
# in run-visual.sh layers the repo source over /work, but masks
# /work/node_modules with an anonymous volume so the image's linux modules win
# over the host's darwin modules.
#
# Rebuild trigger: pnpm-lock.yaml change OR prisma/schema.prisma change.
FROM mcr.microsoft.com/playwright:v1.60.0-noble
RUN corepack enable
WORKDIR /work
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile && pnpm exec prisma generate
