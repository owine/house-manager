import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { signInAs } from './ai/_mock-auth';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

// Shared mutable mock state. vi.mock factories are hoisted above normal
// top-level consts, so anything a factory references must come from
// vi.hoisted (which runs first) rather than a plain `const`.
const hoisted = vi.hoisted(() => {
  // VOYAGE_DIMENSIONS is 1024; hard-code here because the real module is
  // mocked and we can't import it before the factory runs.
  const dim = 1024;
  const queryVector = new Float32Array(dim).fill(0.05);
  return {
    queryVector,
    embedTextsMock: vi.fn(async () => [queryVector]),
    parseMock: vi.fn(),
    state: {
      askEnabled: true,
      parseResponse: null as unknown,
      lastParseArgs: null as Record<string, unknown> | null,
    },
  };
});

// ── Mocks ───────────────────────────────────────────────────────────────────
//
// Only the two external deps are mocked (Voyage embeddings + Anthropic). The
// rest of the askQuestion pipeline — auth gate, rate limit, pgvector top-k
// retrieval, AISuggestionLog persistence — runs for real against the
// Testcontainers pgvector DB.

vi.mock('@/lib/auth', async () => {
  const { currentUserId } = await import('./ai/_mock-auth');
  return {
    auth: vi.fn(async () => {
      const id = currentUserId();
      return id ? { user: { id } } : null;
    }),
  };
});

// getEnv is only consulted by the action for ASK_ENABLED in this path
// (lib/db reads process.env.DATABASE_URL directly, NOT via getEnv, so mocking
// env here does NOT break the Prisma client). A mutable flag lets the guard
// test flip ASK_ENABLED off without re-importing or fighting getEnv's cache.
vi.mock('@/lib/env', () => ({
  getEnv: () => ({ ASK_ENABLED: hoisted.state.askEnabled }),
}));

// embedTexts is mocked to a deterministic query vector (all 0.05, length ===
// the embeddings column dim). The seeded row stores this exact vector so
// cosine distance is ~0 and retrieveTopK returns it first. The real
// VOYAGE_DIMENSIONS / VOYAGE_MAX_BATCH exports are preserved.
vi.mock('@/lib/embedding/voyage', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/embedding/voyage')>();
  return {
    VOYAGE_DIMENSIONS: orig.VOYAGE_DIMENSIONS,
    VOYAGE_MAX_BATCH: orig.VOYAGE_MAX_BATCH,
    embedTexts: hoisted.embedTextsMock,
  };
});

// Anthropic mock: parse() resolves the canned answer, or rejects when
// state.parseResponse is an Error. parsed_output matches askAnswerSchema
// ({answer, citations}); citations:[] avoids enrichCitations DB lookups.
hoisted.parseMock.mockImplementation(async (args: Record<string, unknown>) => {
  hoisted.state.lastParseArgs = args;
  if (hoisted.state.parseResponse instanceof Error) throw hoisted.state.parseResponse;
  return hoisted.state.parseResponse;
});
vi.mock('@/lib/ai/client', () => ({
  getAnthropic: vi.fn(() => ({ messages: { parse: hoisted.parseMock } })),
  ANTHROPIC_MODEL: 'claude-haiku-4-5',
  ANTHROPIC_MAX_TOKENS: 2048,
}));

const { embedTextsMock, parseMock, queryVector: QUERY_VECTOR, state } = hoisted;

const CANNED = {
  parsed_output: { answer: 'Canned answer.', citations: [] },
  usage: { input_tokens: 1, output_tokens: 1 },
};

const CHUNK_TEXT = 'The furnace filter is a 16x25x1 MERV 11 replaced every spring.';

let ctx: IntegrationContext;
let askQuestion: typeof import('@/lib/ask/actions').askQuestion;
let userId: string;
let embeddingId: string;

beforeAll(async () => {
  ctx = await setupIntegration();
  // Imported AFTER setupIntegration set process.env.DATABASE_URL so the
  // action's @/lib/db client connects to the Testcontainers DB.
  ({ askQuestion } = await import('@/lib/ask/actions'));
}, 120_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

async function seed() {
  // FK-safe cleanup.
  await ctx.prisma.$executeRaw`DELETE FROM embeddings`;
  await ctx.prisma.aISuggestionLog.deleteMany();
  await ctx.prisma.note.deleteMany();
  await ctx.prisma.session.deleteMany();
  await ctx.prisma.account.deleteMany();
  await ctx.prisma.user.deleteMany();

  const u = await ctx.prisma.user.create({ data: { email: 'ask@x', name: 'A' } });
  userId = u.id;
  signInAs(userId);

  const note = await ctx.prisma.note.create({
    data: { title: 'Furnace notes', body: CHUNK_TEXT },
  });

  // Vector write mirrors lib/embedding/index.ts: Prisma can't model the
  // pgvector column, so insert via $executeRaw with an explicit
  // ::vector(1024) cast. Stored vector === QUERY_VECTOR ⇒ distance 0.
  embeddingId = randomUUID();
  const vectorLiteral = `[${Array.from(QUERY_VECTOR).join(',')}]`;
  await ctx.prisma.$executeRaw`
    INSERT INTO embeddings (id, "entityType", "entityId", "chunkIndex", text, embedding, "tokenCount", "contentHash", "createdAt")
    VALUES (${embeddingId}, 'NOTE'::"EmbeddingEntityType", ${note.id}, 0, ${CHUNK_TEXT}, ${vectorLiteral}::vector(1024), 20, ${'hash'}, NOW())
  `;
}

describe('askQuestion orchestration (real pgvector)', () => {
  beforeEach(async () => {
    state.askEnabled = true;
    state.parseResponse = null;
    state.lastParseArgs = null;
    embedTextsMock.mockClear();
    parseMock.mockClear();
    await seed();
  });

  it('happy path: embeds query, retrieves chunk, returns canned answer, logs it', async () => {
    state.parseResponse = CANNED;

    const result = await askQuestion({
      messages: [{ role: 'user', content: 'What size is the furnace filter?' }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.answer.answer).toBe('Canned answer.');

    // embedTexts called with the question + query input type.
    expect(embedTextsMock).toHaveBeenCalledWith(['What size is the furnace filter?'], {
      inputType: 'query',
    });

    // The retrieved chunk text was injected into the LAST message handed to
    // the model, and the output format was requested.
    const sentMessages = state.lastParseArgs?.messages as Array<{ content: string }>;
    const lastContent = sentMessages[sentMessages.length - 1].content;
    expect(lastContent).toContain(CHUNK_TEXT);
    expect(state.lastParseArgs?.output_config).toHaveProperty('format');

    // A success log row persisted with kind=ask, the seeded chunk id, a
    // non-null response.
    const log = await ctx.prisma.aISuggestionLog.findFirstOrThrow({ where: { userId } });
    expect(log.kind).toBe('ask');
    expect(log.retrievedChunkIds).toContain(embeddingId);
    expect(log.response).not.toBeNull();
    expect(log.errorReason).toBeNull();
  });

  it('LLM error: returns formError and writes an error log (null response)', async () => {
    state.parseResponse = new Error('upstream exploded');

    const result = await askQuestion({
      messages: [{ role: 'user', content: 'What size is the furnace filter?' }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.formError).toBeTruthy();

    const log = await ctx.prisma.aISuggestionLog.findFirstOrThrow({ where: { userId } });
    expect(log.kind).toBe('ask');
    expect(log.errorReason).toBeTruthy();
    expect(log.response).toBeNull();
    // Retrieval still ran before the failed Anthropic call.
    expect(log.retrievedChunkIds).toContain(embeddingId);
  });

  it('guard: ASK_ENABLED=false short-circuits before embedding', async () => {
    state.askEnabled = false;
    state.parseResponse = CANNED;

    const result = await askQuestion({
      messages: [{ role: 'user', content: 'What size is the furnace filter?' }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.formError).toMatch(/not enabled/i);
    expect(embedTextsMock).not.toHaveBeenCalled();
    // No log row written on the disabled path.
    const count = await ctx.prisma.aISuggestionLog.count({ where: { userId } });
    expect(count).toBe(0);
  });
});
