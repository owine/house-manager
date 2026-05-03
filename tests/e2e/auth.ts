import { expect, type Page } from '@playwright/test';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Meilisearch } from 'meilisearch';
import { INDEX_SETTINGS } from '@/lib/search/schema';

// Each spec runs in the same Postgres container; without a reset, the second
// spec's sign-in flow hits "Unique constraint failed on email" because the
// User row from the first spec is still around.
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const meili = new Meilisearch({
  host: process.env.MEILI_HOST ?? 'http://localhost:7700',
  apiKey: process.env.MEILI_KEY ?? '',
});

export async function resetAuth(): Promise<void> {
  // Truncates auth AND domain tables. Playwright runs workers:1 so specs share
  // the same DB serially; without clearing items/services/etc. between specs,
  // dashboard assertions hit "strict mode violation" from accumulated rows.
  // CASCADE handles FK ordering so we don't have to enumerate child-first.
  // Categories stay (seeded by `prisma seed`; tests open the Category combobox and pick "HVAC" by visible text).
  // house_profile is a per-house singleton; not per-spec state, leave it.
  await prisma.$executeRawUnsafe(`
    TRUNCATE
      attachments,
      reminder_completions,
      notification_logs,
      push_subscriptions,
      service_records,
      warranties,
      notes,
      reminders,
      items,
      vendors,
      sessions,
      accounts,
      verification_tokens,
      users
    RESTART IDENTITY CASCADE
  `);

  // Wipe + recreate the search index so a previous spec's items don't bleed
  // in. Recreating with settings is required: handleSearchIndex's first
  // addDocuments after a bare deleteIndex would auto-create an index WITHOUT
  // filterableAttributes, breaking facet queries. Worker's ensureSearchIndex
  // only runs at startup, not per-job, so we own the priming here.
  await meili.deleteIndex('house').catch(() => {});
  const created = await meili.createIndex('house', { primaryKey: 'id' });
  await meili.tasks.waitForTask(created.taskUid);
  const settings = await meili.index('house').updateSettings(
    // biome-ignore lint/suspicious/noExplicitAny: structural typing on the as-const settings; matches lib/search/init.ts
    INDEX_SETTINGS as any,
  );
  await meili.tasks.waitForTask(settings.taskUid);
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
