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

/**
 * Tables that must SURVIVE a reset. Everything else in the `public` schema is
 * truncated.
 *
 * The list is inverted deliberately. It used to enumerate the tables to clear,
 * which meant every new table was untracked until someone remembered to add it
 * — `systems` never was, and accumulated across every e2e run this repo has
 * done, which is how a committed `systems-empty` baseline ended up being a
 * photograph of fourteen leftover systems. `chat_sessions` (added in #319) had
 * the same hole. Opting a table OUT is a decision someone makes on purpose;
 * opting one IN is a step they forget.
 *
 * The failure mode is now loud (a spec's fixture vanishes) rather than silent
 * (state accumulates for months).
 */
const PRESERVED_TABLES = [
  // Prisma's own bookkeeping. Truncating this makes the DB look unmigrated.
  '_prisma_migrations',
  // Seeded by `prisma seed`; specs open the Category combobox and pick "HVAC"
  // by visible text, so clearing it breaks essentially every spec.
  'categories',
  // Per-house singleton, not per-spec state.
  'house_profile',
];

export async function resetAuth(): Promise<void> {
  // Playwright runs workers:1 so specs share the same DB serially; without
  // clearing items/services/etc. between specs, dashboard assertions hit
  // "strict mode violation" from accumulated rows.
  //
  // The table list is read from the database rather than hand-maintained, so a
  // newly added table is cleared from the moment it exists. See
  // PRESERVED_TABLES above for why this is inverted. CASCADE handles FK
  // ordering, so enumeration order does not matter; RESTART IDENTITY resets
  // sequences. Quoting every name keeps Prisma's PascalCase tables
  // (`Checklist`, `AISuggestionLog`) working alongside the snake_case ones.
  const tables = await prisma.$queryRawUnsafe<Array<{ tablename: string }>>(
    'SELECT tablename FROM pg_tables WHERE schemaname = current_schema()',
  );
  const targets = tables
    .map((t) => t.tablename)
    .filter((name) => !PRESERVED_TABLES.includes(name))
    .map((name) => `"${name}"`);

  // Guard against a schema-introspection failure quietly turning this into a
  // no-op — a reset that silently resets nothing is the bug this replaced.
  if (targets.length === 0) {
    throw new Error('resetAuth: no tables resolved to truncate; check DATABASE_URL/schema');
  }

  await prisma.$executeRawUnsafe(`TRUNCATE ${targets.join(', ')} RESTART IDENTITY CASCADE`);

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
