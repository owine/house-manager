import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

// getChatSession scopes on (id, userId) together. That is a security property,
// not a convenience: without the userId predicate any user could read another
// user's chat thread by guessing an id. The plan for this task specified no
// test at all, so these exist to pin it.

let ctx: IntegrationContext;
let queries: typeof import('@/lib/chat/queries');

beforeAll(async () => {
  ctx = await setupIntegration();
  queries = await import('@/lib/chat/queries');
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.chatSession.deleteMany({});
  await ctx.prisma.user.deleteMany({ where: { id: { in: ['owner', 'stranger'] } } });
  await ctx.prisma.user.createMany({
    data: [
      { id: 'owner', email: 'owner@example.test' },
      { id: 'stranger', email: 'stranger@example.test' },
    ],
    skipDuplicates: true,
  });
});

async function seedSession() {
  return ctx.prisma.chatSession.create({
    data: {
      userId: 'owner',
      title: 'Lightbulbs',
      messages: {
        create: [
          { role: 'USER', content: 'the kitchen pendants take 9W A19 bulbs' },
          { role: 'ASSISTANT', content: 'Noted.' },
        ],
      },
    },
  });
}

describe('getChatSession', () => {
  it('returns the session with its thread in order for the owner', async () => {
    const created = await seedSession();

    const session = await queries.getChatSession(created.id, 'owner');

    expect(session?.id).toBe(created.id);
    expect(session?.title).toBe('Lightbulbs');
    expect(session?.messages.map((m) => m.role)).toEqual(['USER', 'ASSISTANT']);
  });

  // The security property. A stranger must get the same answer as for a
  // nonexistent id — callers cannot distinguish "not yours" from "not there",
  // so a guessed id leaks nothing.
  it('returns null for a session belonging to another user', async () => {
    const created = await seedSession();

    expect(await queries.getChatSession(created.id, 'stranger')).toBeNull();
  });

  it('returns null for an id that does not exist', async () => {
    expect(await queries.getChatSession('no-such-session', 'owner')).toBeNull();
  });
});
