import { execFileSync } from 'node:child_process';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { calendarDateWriteGuard } from '@/lib/calendar-date-guard';

/**
 * Today as a CALENDAR DATE -- UTC midnight, which is the shape the app actually
 * stores (computeNextDueOn -> toUtcMidnight, parseDateInput). Seeding a
 * calendar-date column with `new Date()` writes an INSTANT, which the write guard
 * now rejects: Postgres would truncate it to its UTC day, and after ~19:00 in a
 * negative-offset zone that is the WRONG day.
 */
export function todayCal(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** A calendar date `n` days from today (negative for the past). */
export function calDaysOut(n: number): Date {
  return new Date(todayCal().getTime() + n * 86_400_000);
}

/**
 * Same extension as the real client (lib/db.ts). Without it, integration tests
 * would bypass the calendar-date write guard -- a fixture seeding an instant into
 * a date column would sail through here while throwing in production.
 */
function createTestPrismaClient(adapter: PrismaPg) {
  return new PrismaClient({ adapter }).$extends(calendarDateWriteGuard);
}

import { Meilisearch } from 'meilisearch';
import { startStack, stopStack, type TestStack } from './setup';

export type IntegrationContext = {
  stack: TestStack;
  prisma: ReturnType<typeof createTestPrismaClient>;
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
  const prisma = createTestPrismaClient(adapter);
  const meili = new Meilisearch({ host: stack.meiliUrl, apiKey: 'test' });
  return { stack, prisma, meili };
}

export async function teardownIntegration(ctx: IntegrationContext) {
  await ctx.prisma.$disconnect();
  await stopStack(ctx.stack);
}
