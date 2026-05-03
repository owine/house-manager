import { execFileSync } from 'node:child_process';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Meilisearch } from 'meilisearch';
import { startStack, stopStack, type TestStack } from './setup';

export type IntegrationContext = {
  stack: TestStack;
  prisma: PrismaClient;
  meili: Meilisearch;
};

export async function setupIntegration(): Promise<IntegrationContext> {
  const stack = await startStack();
  process.env.DATABASE_URL = stack.databaseUrl;
  process.env.MEILI_HOST = stack.meiliUrl;
  process.env.MEILI_KEY = 'test';
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: stack.databaseUrl },
    stdio: 'inherit',
  });
  const adapter = new PrismaPg({ connectionString: stack.databaseUrl });
  const prisma = new PrismaClient({ adapter });
  const meili = new Meilisearch({ host: stack.meiliUrl, apiKey: 'test' });
  return { stack, prisma, meili };
}

export async function teardownIntegration(ctx: IntegrationContext) {
  await ctx.prisma.$disconnect();
  await stopStack(ctx.stack);
}

// signInAs: simulate an authenticated session for tests that target Server Actions.
// Usage: at the top of the test file (NOT inside a beforeAll), call:
//   vi.mock('@/lib/auth', async () => {
//     const { __getCurrentUserId } = await import('../helpers');
//     return { auth: vi.fn(async () => { const id = __getCurrentUserId(); return id ? { user: { id } } : null; }) };
//   });
// Then call `signInAs(userId)` or `signInAs(null)` to switch sessions.
//
// IMPORTANT: vi.mock is hoisted per-file. We expose a setter so tests can swap the user
// without re-mocking. The mocked module reads the value at call time.
let __currentUserId: string | null = null;
export function signInAs(userId: string | null): void {
  __currentUserId = userId;
}
export function __getCurrentUserId(): string | null {
  return __currentUserId;
}
