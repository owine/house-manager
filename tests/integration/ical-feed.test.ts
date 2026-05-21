import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

vi.mock('@/lib/env', () => ({
  getEnv: vi.fn(() => ({ APP_URL: 'http://localhost:3000' })),
}));

let ctx: IntegrationContext;
let itemId: string;
let GET: typeof import('@/app/api/calendar/[token]/route').GET;

beforeAll(async () => {
  ctx = await setupIntegration();
  const route = await import('@/app/api/calendar/[token]/route');
  GET = route.GET;
  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'ical-feed-test' },
    create: { slug: 'ical-feed-test', name: 'IcalFeedTest', sortOrder: 999 },
    update: {},
  });
  const item = await ctx.prisma.item.create({ data: { name: 'Test Item', categoryId: cat.id } });
  itemId = item.id;
}, 180_000);
afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.reminder.deleteMany();
  await ctx.prisma.session.deleteMany();
  await ctx.prisma.account.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({
    data: { id: 'u1', email: 'u1@example.com', name: 'U1', icsToken: 'tok-abc' },
  });
});

async function fetchFeed(token: string): Promise<string> {
  const res = await GET(new Request(`http://test/api/calendar/${token}.ics`), {
    params: Promise.resolve({ token: `${token}.ics` }),
  });
  expect(res.status).toBe(200);
  return res.text();
}

describe('ICS feed route', () => {
  it('shows a recurring reminder with a ✅ completed event on the completion date', async () => {
    const reminder = await ctx.prisma.reminder.create({
      data: {
        title: 'Replace HVAC filter',
        description: 'use MERV 13',
        recurrence: { kind: 'interval', every: 30, unit: 'day' },
        leadTimeDays: 3,
        notifyUserIds: ['u1'],
        targets: { create: { itemId, nextDueOn: new Date('2026-06-30T00:00:00Z') } },
      },
      include: { targets: true },
    });
    await ctx.prisma.reminderCompletion.create({
      data: {
        reminderId: reminder.id,
        targetId: reminder.targets[0].id,
        completedById: 'u1',
        completedOn: new Date('2026-05-04T10:00:00Z'),
      },
    });

    const text = await fetchFeed('tok-abc');
    expect(text).toContain('SUMMARY:✅ Replace HVAC filter');
    expect(text).toContain('SUMMARY:Replace HVAC filter'); // the due/projected series too
  });

  it('omits the year-9999 sentinel event for a completed one-shot but keeps the ✅', async () => {
    const reminder = await ctx.prisma.reminder.create({
      data: {
        title: 'Register warranty',
        recurrence: { kind: 'once' },
        leadTimeDays: 3,
        notifyUserIds: ['u1'],
        targets: { create: { itemId, nextDueOn: new Date('9999-12-31T00:00:00.000Z') } },
      },
      include: { targets: true },
    });
    await ctx.prisma.reminderCompletion.create({
      data: {
        reminderId: reminder.id,
        targetId: reminder.targets[0].id,
        completedById: 'u1',
        completedOn: new Date('2026-05-04T10:00:00Z'),
      },
    });

    const text = await fetchFeed('tok-abc');
    expect(text).toContain('SUMMARY:✅ Register warranty');
    expect(text).not.toContain('9999');
  });

  it('keeps both the ✅ and the plain due event when they fall on the same UTC day', async () => {
    const due = new Date('2026-05-10T00:00:00Z');
    const reminder = await ctx.prisma.reminder.create({
      data: {
        title: 'Test collision',
        recurrence: { kind: 'once' },
        leadTimeDays: 3,
        notifyUserIds: ['u1'],
        targets: { create: { itemId, nextDueOn: due } },
      },
      include: { targets: true },
    });
    await ctx.prisma.reminderCompletion.create({
      data: {
        reminderId: reminder.id,
        targetId: reminder.targets[0].id,
        completedById: 'u1',
        completedOn: new Date('2026-05-10T08:00:00Z'),
      },
    });

    const text = await fetchFeed('tok-abc');
    expect(text).toContain('SUMMARY:✅ Test collision');
    expect(text).toContain('SUMMARY:Test collision');
    expect((text.match(/BEGIN:VEVENT/g) ?? []).length).toBe(2);
  });
});
