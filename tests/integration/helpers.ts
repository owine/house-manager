import { execFileSync } from 'node:child_process';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { startStack, stopStack, type TestStack } from './setup';

export type IntegrationContext = { stack: TestStack; prisma: PrismaClient };

export async function setupIntegration(): Promise<IntegrationContext> {
  const stack = await startStack();
  process.env.DATABASE_URL = stack.databaseUrl;
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: stack.databaseUrl },
    stdio: 'inherit',
  });
  const adapter = new PrismaPg({ connectionString: stack.databaseUrl });
  const prisma = new PrismaClient({ adapter });
  return { stack, prisma };
}

export async function teardownIntegration(ctx: IntegrationContext) {
  await ctx.prisma.$disconnect();
  await stopStack(ctx.stack);
}
