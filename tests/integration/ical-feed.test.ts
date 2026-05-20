import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildIcal } from '@/lib/ical/build';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

let ctx: IntegrationContext;

beforeAll(async () => {
  ctx = await setupIntegration();
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

describe('buildIcal', () => {
  it('returns a VCALENDAR with one VEVENT per occurrence (12 for a recurring reminder)', () => {
    const text = buildIcal(
      [
        {
          id: 'r1',
          title: 'Replace HVAC filter',
          description: 'use MERV 13',
          recurrence: { kind: 'interval', every: 30, unit: 'day' },
          nextDueOn: new Date('2026-06-30T00:00:00Z'),
          leadTimeDays: 3,
        },
      ],
      'https://example.com',
    );
    expect(text).toContain('BEGIN:VCALENDAR');
    expect(text).toContain('END:VCALENDAR');
    const eventCount = (text.match(/BEGIN:VEVENT/g) ?? []).length;
    expect(eventCount).toBe(12);
    expect(text).toContain('SUMMARY:Replace HVAC filter');
    expect(text).toContain('TRIGGER:-P3D'); // 3 days in compact period notation
  });

  it('returns 0 events for an empty list', () => {
    const text = buildIcal([], 'https://example.com');
    expect(text).toContain('BEGIN:VCALENDAR');
    expect(text).not.toContain('BEGIN:VEVENT');
  });
});
