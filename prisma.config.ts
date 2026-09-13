import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, env } from 'prisma/config';

// Prisma 7 no longer loads `.env` itself, and `env()` below resolves at config
// *load* time -- so without this every `prisma` CLI invocation (generate,
// migrate, migrate status, and knip's config plugin) dies with
// `PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_URL`
// on any machine that hasn't exported DATABASE_URL by hand.
//
// This matches what every other entry point in the repo already does
// explicitly: Next.js loads `.env` natively, the e2e harness uses
// `tsx --env-file=.env`, and Vitest uses `dotenvFallbacks()` in vitest.env.ts.
// The Prisma CLI was the one entry point that never got wired up.
//
// `process.loadEnvFile` is Node's built-in `--env-file` reader, so no `dotenv`
// dependency is needed -- `engines.node` is pinned to 24.20.0, well past the
// 20.12 that added it. It does NOT overwrite variables that are already set,
// which preserves the same "the shell wins" rule vitest.env.ts documents: CI's
// job-level DATABASE_URL and a one-off `DATABASE_URL=… pnpm db:migrate` both
// still take precedence.
//
// Resolved against this file rather than `process.cwd()` so it behaves the
// same however the CLI was invoked, and guarded because CI has no `.env` --
// `loadEnvFile` throws ENOENT rather than shrugging.
const envPath = fileURLToPath(new URL('.env', import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);

export default defineConfig({
  datasource: {
    url: env('DATABASE_URL'),
  },
  migrations: {
    seed: 'tsx ./prisma/seed.ts',
  },
});
