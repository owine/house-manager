import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

// Never call Voyage; capture the text that would have been embedded.
const embeddedTexts: string[][] = [];
vi.mock('@/lib/embedding/voyage', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/embedding/voyage')>();
  return {
    ...orig,
    embedTexts: vi.fn(async (texts: string[]) => {
      embeddedTexts.push(texts);
      return texts.map(() => new Array(1024).fill(0.001));
    }),
  };
});

let ctx: IntegrationContext;
let embedding: typeof import('@/lib/embedding');

beforeAll(async () => {
  ctx = await setupIntegration();
  embedding = await import('@/lib/embedding');
}, 180_000);

afterAll(async () => {
  await ctx.prisma.houseProfile.deleteMany();
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  embeddedTexts.length = 0;
  await ctx.prisma.$executeRaw`DELETE FROM embeddings`;
  await ctx.prisma.note.deleteMany();
  await ctx.prisma.houseProfile.deleteMany();
  await ctx.prisma.houseProfile.create({ data: { timezone: 'America/Chicago' } });
});

describe('note canonical text', () => {
  it('dates a note by the house day it was written, not its UTC day', async () => {
    // 20:00 CDT on Jul 14 is already Jul 15 in UTC.
    const note = await ctx.prisma.note.create({
      data: {
        title: 'Evening note',
        body: 'Filter looked grey.',
        createdAt: new Date('2026-07-15T01:00:00Z'),
      },
    });

    await embedding.embedEntity('NOTE', note.id);

    const text = embeddedTexts.flat().join('\n');
    expect(text).toContain('Created: 2026-07-14');
    expect(text).not.toContain('2026-07-15');
  });
});
