import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => ({ user: { id: 'u1', name: 'Test' } })),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// Capture what actually reaches pg-boss. Deliberately NOT mocking
// `@/lib/embedding/enqueue` — the ASK_ENABLED gate lives inside it, and
// stubbing the helper would test nothing.
const enqueued: Array<{ queue: string; data: unknown }> = [];
vi.mock('@/lib/queue', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/queue')>();
  return {
    ...orig,
    getBoss: vi.fn(async () => ({
      send: vi.fn(async (queue: string, data: unknown) => {
        enqueued.push({ queue, data });
        return 'fake-job-id';
      }),
    })),
  };
});

// Capture the text handed to Voyage without calling it. This is what proves
// the producer select in lib/embedding/index.ts actually loads everything
// `canonicalizePart` reads — a canonicalizer whose select is stale compiles,
// passes review, and embeds nothing. That has happened in this repo before.
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

type EmbedJob = { entityType: string; entityId: string };

function embedJobs(): EmbedJob[] {
  return enqueued.filter((e) => e.queue === 'embed.content').map((e) => e.data as EmbedJob);
}

let ctx: IntegrationContext;
let actions: typeof import('@/lib/parts/actions');
let cascade: typeof import('@/lib/embedding/cascade');
let embedding: typeof import('@/lib/embedding');
let categoryId: string;

beforeAll(async () => {
  ctx = await setupIntegration();
  actions = await import('@/lib/parts/actions');
  cascade = await import('@/lib/embedding/cascade');
  embedding = await import('@/lib/embedding');
  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'parts-embedding' },
    create: { slug: 'parts-embedding', name: 'Fixtures', sortOrder: 31 },
    update: {},
  });
  categoryId = cat.id;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
  delete process.env.ASK_ENABLED;
});

beforeEach(async () => {
  enqueued.length = 0;
  embeddedTexts.length = 0;
  process.env.ASK_ENABLED = 'true';
  await ctx.prisma.$executeRaw`DELETE FROM embeddings`;
  await ctx.prisma.partLink.deleteMany();
  await ctx.prisma.part.deleteMany();
  await ctx.prisma.item.deleteMany();
  await ctx.prisma.system.deleteMany();
});

describe('part mutations enqueue an embed', () => {
  it('createPart enqueues PART when ASK_ENABLED', async () => {
    const created = await actions.createPart({
      name: 'S14 string light bulb',
      kind: 'BULB',
      metadata: { base: 'E26', shape: 'S14' },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(embedJobs()).toContainEqual(
      expect.objectContaining({ entityType: 'PART', entityId: created.data.id }),
    );
  });

  it('createPart enqueues nothing when ASK_ENABLED is off', async () => {
    process.env.ASK_ENABLED = 'false';
    const created = await actions.createPart({ name: 'Quiet bulb', kind: 'BULB' });
    expect(created.ok).toBe(true);
    expect(embedJobs()).toHaveLength(0);
    // The search index is not gated on ASK_ENABLED — it still fires.
    expect(enqueued.some((e) => e.queue === 'search.index')).toBe(true);
  });

  it('archive and restore both re-enqueue (archive tombstones, restore rebuilds)', async () => {
    const created = await actions.createPart({ name: 'Belt', kind: 'BELT' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    enqueued.length = 0;

    await actions.archivePart(created.data.id);
    expect(embedJobs()).toContainEqual(
      expect.objectContaining({ entityType: 'PART', entityId: created.data.id }),
    );

    enqueued.length = 0;
    await actions.restorePart(created.data.id);
    expect(embedJobs()).toContainEqual(
      expect.objectContaining({ entityType: 'PART', entityId: created.data.id }),
    );
  });

  it('linking a part to a parent re-enqueues it — the parent name is embedded', async () => {
    const item = await ctx.prisma.item.create({ data: { name: 'Backyard lights', categoryId } });
    const created = await actions.createPart({ name: 'S14 bulb', kind: 'BULB' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    enqueued.length = 0;

    await actions.linkPartToParent({ partId: created.data.id, itemId: item.id });
    expect(embedJobs()).toContainEqual(
      expect.objectContaining({ entityType: 'PART', entityId: created.data.id }),
    );
  });
});

describe('rename cascades reach parts', () => {
  it('renaming a linked item re-enqueues the part', async () => {
    const item = await ctx.prisma.item.create({ data: { name: 'Backyard lights', categoryId } });
    const part = await ctx.prisma.part.create({
      data: { name: 'S14 bulb', kind: 'BULB', links: { create: [{ itemId: item.id }] } },
    });
    enqueued.length = 0;

    await cascade.enqueueItemRenameCascade(item.id);
    expect(embedJobs()).toContainEqual(
      expect.objectContaining({ entityType: 'PART', entityId: part.id }),
    );
  });

  it('renaming a linked system re-enqueues the part', async () => {
    const sys = await ctx.prisma.system.create({ data: { name: 'HVAC' } });
    const part = await ctx.prisma.part.create({
      data: {
        name: 'FPR 10 20x25x1',
        kind: 'AIR_FILTER',
        links: { create: [{ systemId: sys.id }] },
      },
    });
    enqueued.length = 0;

    await cascade.enqueueSystemRenameCascade(sys.id);
    expect(embedJobs()).toContainEqual(
      expect.objectContaining({ entityType: 'PART', entityId: part.id }),
    );
  });
});

describe('tombstone cleanup', () => {
  // `Embedding` has no FK to its entity, so nothing at the database level
  // removes these rows — `embedEntity` has to notice the entity is gone.
  async function seedEmbedding(partId: string) {
    const zeros = `[${new Array(1024).fill(0).join(',')}]`;
    await ctx.prisma.$executeRawUnsafe(
      `INSERT INTO embeddings (id, "entityType", "entityId", "chunkIndex", text, embedding, "tokenCount", "contentHash", "createdAt")
       VALUES ($1, 'PART', $2, 0, 'stale', $3::vector(1024), 1, 'deadbeef', NOW())`,
      `emb-${partId}`,
      partId,
      zeros,
    );
  }

  async function countFor(partId: string) {
    return ctx.prisma.embedding.count({ where: { entityType: 'PART', entityId: partId } });
  }

  it('deletes embeddings for a part row that no longer exists', async () => {
    const part = await ctx.prisma.part.create({ data: { name: 'Doomed', kind: 'OTHER' } });
    await seedEmbedding(part.id);
    await ctx.prisma.part.delete({ where: { id: part.id } });

    const result = await embedding.embedEntity('PART', part.id);
    expect(result.status).toBe('deleted');
    expect(await countFor(part.id)).toBe(0);
  });

  it('deletes embeddings for an archived part', async () => {
    const part = await ctx.prisma.part.create({
      data: { name: 'Retired', kind: 'OTHER', archivedAt: new Date() },
    });
    await seedEmbedding(part.id);

    const result = await embedding.embedEntity('PART', part.id);
    expect(result.status).toBe('deleted');
    expect(await countFor(part.id)).toBe(0);
  });
});

describe('the embedded text carries the spec and the parents', () => {
  it('round-trips every field canonicalizePart reads, and no reserved key', async () => {
    const item = await ctx.prisma.item.create({
      data: { name: 'Backyard string lights', categoryId },
    });
    const sys = await ctx.prisma.system.create({ data: { name: 'Outdoor lighting' } });
    const part = await ctx.prisma.part.create({
      data: {
        name: 'S14 LED string light bulb',
        kind: 'BULB',
        manufacturer: 'Feit Electric',
        model: 'S14/LED/24',
        sku: 'S14-LED-24',
        typicalCost: '32.50',
        location: 'Garage shelf B',
        notes: 'Warm amber; dimmable on the outdoor timer.',
        metadata: {
          base: 'E26',
          shape: 'S14',
          colorTempK: 2200,
          _provenance: { base: 'inferred' },
        },
        links: { create: [{ itemId: item.id }, { systemId: sys.id }] },
      },
    });

    const result = await embedding.embedEntity('PART', part.id);
    expect(result.status).toBe('embedded');

    const text = (embeddedTexts[0] ?? []).join('\n');
    expect(text).toContain('Part: S14 LED string light bulb');
    expect(text).toContain('Kind: Bulb');
    expect(text).toContain('Manufacturer: Feit Electric');
    expect(text).toContain('Model: S14/LED/24');
    expect(text).toContain('SKU: S14-LED-24');
    expect(text).toContain('Location: Garage shelf B');
    // A Prisma Decimal reaches fmtMoney as an object; the select stringifies it.
    expect(text).toContain('Typical cost: $32.50');
    // The spec — the question "what bulb goes in the backyard string lights?"
    // is answered by these three lines, not by the part's name.
    expect(text).toContain('base: E26');
    expect(text).toContain('shape: S14');
    expect(text).toContain('colorTempK: 2200');
    // Both parents, from the `links` relation the select has to load.
    expect(text).toContain('Installed in: Backyard string lights, Outdoor lighting');
    expect(text).toContain('Warm amber');
    expect(text).not.toContain('_provenance');
    expect(text).not.toContain('inferred');
  });
});
