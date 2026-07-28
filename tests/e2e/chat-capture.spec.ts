// E2E coverage for conversational capture (Ask v2): reviewing and applying a
// proposal that already exists in the DB.
//
// The model half of this feature (dump -> proposals) cannot run under the
// e2e harness: tests/e2e/_env-local.sh sets ASK_ENABLED="false" and
// placeholder Anthropic/Voyage keys, so /ask renders the disabled-composer
// fallback and there is no fake AI server to answer a real chatTurn call.
// That half is covered by the integration tests in tests/integration/chat/
// (turn.test.ts), which inject `_mock-ai-client`.
//
// What CAN run without a model: seeding a ChatSession + ChatMessage(s) +
// ChatProposal straight into the DB (exactly the shape getChatSession reads)
// and driving the resulting card through /ask/<sessionId> — apply, reject,
// and the STALE re-confirm affordance all write to real records with no
// model involved.

import { expect, test } from '@playwright/test';
import { PrismaPg } from '@prisma/adapter-pg';
import type { ChatProposalKind, ChatProposalStatus, ChatRole, Prisma } from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import { resetAuth, signIn } from './auth';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

test.beforeEach(async () => {
  await resetAuth();
  // resetAuth() doesn't know about the chat tables — clear them here so
  // sessions/proposals don't leak across specs in this file (or later files;
  // Playwright runs workers:1, sharing one Postgres container serially).
  await prisma.$executeRawUnsafe(
    `TRUNCATE chat_sessions, chat_messages, chat_proposals RESTART IDENTITY CASCADE`,
  );
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

// ─── Seed helpers ───────────────────────────────────────────────────────────

/** The mock-OIDC user (tests/e2e/mock-oidc.ts) — created by the adapter on first sign-in. */
async function getSignedInUserId(): Promise<string> {
  const user = await prisma.user.findFirstOrThrow({ where: { email: 'test@example.com' } });
  return user.id;
}

async function getHvacCategoryId(): Promise<string> {
  const category = await prisma.category.findFirstOrThrow({ where: { slug: 'hvac' } });
  return category.id;
}

async function seedItem(name: string, location: string | null = null): Promise<string> {
  const categoryId = await getHvacCategoryId();
  const item = await prisma.item.create({
    data: { name, categoryId, location },
    select: { id: true },
  });
  return item.id;
}

type SeedProposalOpts = {
  userId: string;
  sessionTitle?: string;
  userContent: string;
  assistantContent: string;
  kind: ChatProposalKind;
  targetType: string | null;
  targetId: string | null;
  payload: Prisma.InputJsonValue;
  status?: ChatProposalStatus;
  baseUpdatedAt?: Date | null;
  beforeSnapshot?: Prisma.InputJsonValue | null;
};

/** Seed a ChatSession with one user turn + one assistant turn carrying a single proposal. */
async function seedSessionWithProposal(
  opts: SeedProposalOpts,
): Promise<{ sessionId: string; proposalId: string }> {
  const session = await prisma.chatSession.create({
    data: { userId: opts.userId, title: opts.sessionTitle ?? 'Seeded conversation' },
    select: { id: true },
  });
  const userRole: ChatRole = 'USER';
  const assistantRole: ChatRole = 'ASSISTANT';
  await prisma.chatMessage.create({
    data: { sessionId: session.id, role: userRole, content: opts.userContent },
  });
  const assistantMessage = await prisma.chatMessage.create({
    data: { sessionId: session.id, role: assistantRole, content: opts.assistantContent },
  });
  const proposal = await prisma.chatProposal.create({
    data: {
      messageId: assistantMessage.id,
      kind: opts.kind,
      targetType: opts.targetType,
      targetId: opts.targetId,
      payload: opts.payload,
      status: opts.status ?? 'PENDING',
      baseUpdatedAt: opts.baseUpdatedAt ?? null,
      beforeSnapshot: opts.beforeSnapshot ?? undefined,
    },
    select: { id: true },
  });
  return { sessionId: session.id, proposalId: proposal.id };
}

// ─── Test 1 (@critical): review and accept a CREATE_SERVICE_RECORD proposal ─

test('reviews a seeded proposal and applies it @critical', async ({ page, context }) => {
  await context.clearCookies();
  await signIn(page);
  const userId = await getSignedInUserId();

  const itemId = await seedItem('Water Heater');

  const { sessionId } = await seedSessionWithProposal({
    userId,
    sessionTitle: 'Water heater pilot light',
    userContent: 'Reset the water heater pilot light today, 2026-07-20.',
    assistantContent: 'Got it — here is a proposed service record.',
    kind: 'CREATE_SERVICE_RECORD',
    targetType: 'SERVICE_RECORD',
    targetId: null,
    payload: {
      kind: 'CREATE_SERVICE_RECORD',
      summary: { value: 'Reset water heater pilot light', source: 'user' },
      performedOn: { value: '2026-07-20', source: 'user' },
      selfPerformed: true,
      targets: [{ itemId, systemId: null }],
    },
  });

  await page.goto(`/ask/${sessionId}`);

  await expect(page.getByRole('heading', { name: 'Water heater pilot light' })).toBeVisible();
  await expect(
    page.getByText('Reset the water heater pilot light today, 2026-07-20.'),
  ).toBeVisible();
  await expect(page.getByText('Got it — here is a proposed service record.')).toBeVisible();

  // The card renders the create-kind diff: no before value, just the proposed after.
  await expect(page.getByText('New service record')).toBeVisible();
  await expect(page.getByText('Reset water heater pilot light')).toBeVisible();
  await expect(page.getByText('Jul 20, 2026')).toBeVisible();

  await page.getByRole('button', { name: 'Accept' }).click();

  // Card flips to its terminal ACCEPTED message; Accept disappears.
  await expect(page.getByText('This proposal has been applied.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept' })).toHaveCount(0);

  // Backend state: the service record now exists, targeting the seeded item.
  const record = await prisma.serviceRecord.findFirst({
    where: { summary: 'Reset water heater pilot light' },
    include: { targets: true },
  });
  expect(record).not.toBeNull();
  expect(record?.selfPerformed).toBe(true);
  expect(record?.targets.some((t) => t.itemId === itemId)).toBe(true);

  const proposalAfter = await prisma.chatProposal.findFirst({
    where: { message: { sessionId } },
  });
  expect(proposalAfter?.status).toBe('ACCEPTED');
  expect(proposalAfter?.appliedEntityId).toBe(record?.id);
});

// ─── Test 2 (non-critical): reject a proposal ───────────────────────────────

test('rejects a seeded proposal without writing a record', async ({ page, context }) => {
  await context.clearCookies();
  await signIn(page);
  const userId = await getSignedInUserId();

  const { sessionId, proposalId } = await seedSessionWithProposal({
    userId,
    sessionTitle: 'A note about the garage door',
    userContent: 'The garage door opener battery is low.',
    assistantContent: 'Want me to log a note about that?',
    kind: 'CREATE_NOTE',
    targetType: 'NOTE',
    targetId: null,
    payload: {
      kind: 'CREATE_NOTE',
      title: { value: 'Garage door opener battery low', source: 'user' },
      body: { value: 'The garage door opener remote battery is low.', source: 'user' },
      itemId: null,
    },
  });

  await page.goto(`/ask/${sessionId}`);
  await expect(page.getByText('New note')).toBeVisible();

  await page.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByText('This proposal was dismissed.')).toBeVisible();

  const proposal = await prisma.chatProposal.findUniqueOrThrow({ where: { id: proposalId } });
  expect(proposal.status).toBe('REJECTED');
  const note = await prisma.note.findFirst({ where: { title: 'Garage door opener battery low' } });
  expect(note).toBeNull();
});

// ─── Test 3 (non-critical): STALE proposal shows the re-confirm affordance ──

test('a STALE proposal shows Review changes instead of Accept, and refresh re-diffs against the current row', async ({
  page,
  context,
}) => {
  await context.clearCookies();
  await signIn(page);
  const userId = await getSignedInUserId();

  const itemId = await seedItem('Furnace', 'Garage');
  const itemAtPropose = await prisma.item.findUniqueOrThrow({
    where: { id: itemId },
    select: { updatedAt: true },
  });

  const { sessionId } = await seedSessionWithProposal({
    userId,
    sessionTitle: 'Furnace moved',
    userContent: 'The furnace actually lives in the basement now.',
    assistantContent: 'Updating the furnace location.',
    kind: 'UPDATE_ITEM',
    targetType: 'ITEM',
    targetId: itemId,
    payload: {
      kind: 'UPDATE_ITEM',
      itemId,
      location: { value: 'Basement', source: 'user' },
    },
    status: 'STALE',
    baseUpdatedAt: itemAtPropose.updatedAt,
    beforeSnapshot: { location: 'Garage' },
  });

  // Mutate the target row between seed and visit — this is what made the
  // proposal stale: the row's updatedAt no longer matches baseUpdatedAt.
  await prisma.item.update({ where: { id: itemId }, data: { location: 'Attic' } });

  await page.goto(`/ask/${sessionId}`);

  await expect(page.getByText('Changed')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review changes' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Review changes' }).click();

  // Refreshed diff re-reads the CURRENT row ("Attic"), not the stale
  // beforeSnapshot ("Garage"); the proposed value is unchanged. `exact: true`
  // disambiguates from the seeded user message, which also happens to
  // contain the (lowercase) substring "basement".
  await expect(page.getByText('Attic', { exact: true })).toBeVisible();
  await expect(page.getByText('Basement', { exact: true })).toBeVisible();
  await expect(page.getByText('Garage')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Accept' })).toBeVisible();
});

// ─── Test 4 (non-critical): reload preserves the thread ────────────────────

test('reloading the session route preserves the thread and its proposal card', async ({
  page,
  context,
}) => {
  await context.clearCookies();
  await signIn(page);
  const userId = await getSignedInUserId();

  const itemId = await seedItem('Dishwasher');

  const { sessionId } = await seedSessionWithProposal({
    userId,
    sessionTitle: 'Dishwasher service',
    userContent: 'Ran the dishwasher self-clean cycle today.',
    assistantContent: 'Logged a service record proposal for that.',
    kind: 'CREATE_SERVICE_RECORD',
    targetType: 'SERVICE_RECORD',
    targetId: null,
    payload: {
      kind: 'CREATE_SERVICE_RECORD',
      summary: { value: 'Ran self-clean cycle', source: 'user' },
      performedOn: { value: '2026-07-21', source: 'user' },
      selfPerformed: true,
      targets: [{ itemId, systemId: null }],
    },
  });

  await page.goto(`/ask/${sessionId}`);
  await expect(page.getByText('Ran the dishwasher self-clean cycle today.')).toBeVisible();
  await expect(page.getByText('New service record')).toBeVisible();

  await page.reload();

  await expect(page.getByRole('heading', { name: 'Dishwasher service' })).toBeVisible();
  await expect(page.getByText('Ran the dishwasher self-clean cycle today.')).toBeVisible();
  await expect(page.getByText('Logged a service record proposal for that.')).toBeVisible();
  await expect(page.getByText('New service record')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept' })).toBeVisible();
});
