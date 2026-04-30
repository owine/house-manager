import { expect, type Page } from '@playwright/test';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

// Each spec runs in the same Postgres container; without a reset, the second
// spec's sign-in flow hits "Unique constraint failed on email" because the
// User row from the first spec is still around.
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

export async function resetAuth(): Promise<void> {
  // Delete in FK-safe order: Session and Account reference User.
  await prisma.session.deleteMany();
  await prisma.account.deleteMany();
  await prisma.verificationToken.deleteMany();
  await prisma.user.deleteMany();
}

export async function signIn(page: Page): Promise<void> {
  // `/` redirects unauthenticated users straight to Auth.js's sign-in page,
  // which renders the "Sign in with Authelia" provider button.
  await page.goto('/');
  // Guard against a regression where `/` stops redirecting to sign-in.
  // Without this, a regression would surface as a confusing "button not
  // found" failure on the next line instead of a clear URL mismatch.
  await expect(page).toHaveURL(/\/api\/auth\/signin/);
  await Promise.all([
    page.waitForNavigation({ timeout: 30_000 }),
    page.getByRole('button', { name: 'Sign in with Authelia' }).click(),
  ]);
}
