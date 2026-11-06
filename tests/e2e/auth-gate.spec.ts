// Regression: the `app/(app)` layout redirect is not an auth boundary. Next
// renders a route's layout and page segments in parallel, so before every page
// gated itself (lib/auth-guard.ts) a cookieless GET /items carried the seeded
// item names in its RSC payload while the layout was busy redirecting, and a
// MEMBER's GET /admin/ai carried the admin page. Assert on the response BODY,
// not the status or the final URL: a redirect status is exactly what the leaky
// version returned too.
import { expect, test } from '@playwright/test';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { resetAuth, signIn } from './auth';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const SECRET_NAME = 'Gate Canary Furnace 7f3a';
// Rendered only by the admin AI page body (its PageHeader description).
const ADMIN_ONLY_TEXT = 'Activity from the last 24 hours.';

let itemId: string;

test.beforeEach(async () => {
  await resetAuth();
  const category = await prisma.category.findFirstOrThrow({ where: { slug: 'hvac' } });
  ({ id: itemId } = await prisma.item.create({
    data: { name: SECRET_NAME, categoryId: category.id },
  }));
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('unauthenticated requests receive no page data @critical', async ({ playwright, baseURL }) => {
  const anon = await playwright.request.newContext({ baseURL }); // no cookies
  try {
    for (const path of ['/items', `/items/${itemId}`, '/dashboard']) {
      const res = await anon.get(path, { maxRedirects: 0 });
      expect(await res.text(), `${path} leaked the seeded item`).not.toContain(SECRET_NAME);
    }
  } finally {
    await anon.dispose();
  }
});

test('a MEMBER receives no admin page data @critical', async ({ page }) => {
  await signIn(page); // the mock-OIDC user is created with the default MEMBER role
  const res = await page.request.get('/admin/ai', { maxRedirects: 0 });
  expect(await res.text()).not.toContain(ADMIN_ONLY_TEXT);
});
