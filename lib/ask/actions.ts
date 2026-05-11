'use server';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { EmbeddingEntityType } from '@prisma/client';
import { ANTHROPIC_MAX_TOKENS, ANTHROPIC_MODEL, getAnthropic } from '@/lib/ai/client';
import { createSuggestionLog } from '@/lib/ai/log';
import { ASK_SYSTEM_PROMPT } from '@/lib/ai/prompts';
import { checkRateLimit } from '@/lib/ai/rate-limit';
import {
  type AskAnswer,
  type AskCitation,
  askAnswerSchema,
  askQuestionInputSchema,
} from '@/lib/ai/schemas';
import { classifyAnthropicError, userFacingMessage } from '@/lib/ai/suggest/_shared';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { embedTexts } from '@/lib/embedding/voyage';
import { getEnv } from '@/lib/env';
import { getLogger } from '@/lib/logger';
import type { ActionResult } from '@/lib/result';
import { retrieveTopK } from './retrieve';
import { stripInlineCitationTags } from './strip-tags';

const logger = getLogger('ask.actions');

// Top-k chunks per question. 12 is a sweet spot for a single Anthropic round
// trip: enough surface for multi-faceted answers, well under the model's
// context window.
const RETRIEVAL_K = 12;

/**
 * Citation with optional parent-entity info for ATTACHMENT rows. The LLM
 * returns plain `AskCitation` (entityType + entityId); the action enriches
 * attachments by looking up their parent FK so the UI can deep-link
 * `/items/<id>?attachment=<aid>` instead of rendering a non-link chip.
 */
export type EnrichedAskCitation = AskCitation & {
  parent?: {
    entityType: 'ITEM' | 'NOTE' | 'SERVICE_RECORD' | 'WARRANTY';
    entityId: string;
  };
};

export type EnrichedAskAnswer = {
  answer: string;
  citations: EnrichedAskCitation[];
};

export type AskQuestionData = {
  logId: string;
  answer: EnrichedAskAnswer;
};

/**
 * Answer a user question with RAG over their content. Pipeline:
 *
 *   1. Auth + rate limit.
 *   2. Embed the question via Voyage (`input_type=query`).
 *   3. Cosine top-k against the `embeddings` table.
 *   4. Build a user-content block: question + numbered chunks with
 *      `[entityType:entityId]` tags so the LLM can cite by reference.
 *   5. Call Anthropic `messages.parse` with the Ask system prompt and
 *      `askAnswerSchema` as the output schema.
 *   6. Persist an `AISuggestionLog` row with kind='ask' + the retrieved
 *      chunk IDs + citation count for replay / debugging.
 *
 * Errors are surfaced as `{ ok: false, formError }`. Every call writes a
 * log row (with `errorReason` populated on failure) so the admin AI
 * dashboard's Ask tile shows accurate counts.
 */
export async function askQuestion(input: unknown): Promise<ActionResult<AskQuestionData>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, formError: 'Unauthorized' };
  const userId = session.user.id;

  // ASK_ENABLED gate. Mirrors the worker-side check so the route stays
  // disabled if the feature isn't deployed.
  const { ASK_ENABLED } = getEnv();
  if (!ASK_ENABLED) return { ok: false, formError: 'Ask is not enabled on this deployment.' };

  const parsed = askQuestionInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { question, entityTypes } = parsed.data;

  const rl = await checkRateLimit(userId);
  if (!rl.allowed) {
    await createSuggestionLog({
      userId,
      kind: 'ask',
      userPrompt: question,
      inventorySnapshotIds: [],
      response: null,
      errorReason: 'user_rate_limit',
      model: ANTHROPIC_MODEL,
      retrievedChunkIds: [],
    });
    return { ok: false, formError: `Hourly limit reached (${rl.used}/10).` };
  }

  // Step 2 — embed the question.
  let questionEmbedding: Float32Array;
  try {
    const embeds = await embedTexts([question], { inputType: 'query' });
    const first = embeds[0];
    if (!first) throw new Error('voyage returned no embedding');
    questionEmbedding = first;
  } catch (err) {
    logger.error({ err, userId }, 'voyage embed failed');
    await createSuggestionLog({
      userId,
      kind: 'ask',
      userPrompt: question,
      inventorySnapshotIds: [],
      response: null,
      errorReason: 'embed_failed',
      model: ANTHROPIC_MODEL,
      retrievedChunkIds: [],
    });
    return { ok: false, formError: 'Could not embed your question. Try again.' };
  }

  // Step 3 — cosine top-k retrieval.
  const chunks = await retrieveTopK(questionEmbedding, {
    k: RETRIEVAL_K,
    entityTypes: entityTypes as EmbeddingEntityType[] | undefined,
  });
  const retrievedChunkIds = chunks.map((c) => c.embeddingId);

  // Step 4 — build user content. We use plain text with bracket-tagged
  // chunks; the model is instructed (system prompt) to cite by repeating
  // the tag. Empty-context case is allowed — the model can say it doesn't
  // know rather than the action refusing entirely.
  const contextBlock =
    chunks.length === 0
      ? "(no relevant records were retrieved from the user's content)"
      : chunks
          .map(
            (c, i) =>
              `[chunk ${i + 1}] entityType=${c.entityType} entityId=${c.entityId}\n${c.text}`,
          )
          .join('\n\n---\n\n');

  const userContent = `Question:\n${question}\n\n---\n\nRetrieved context:\n${contextBlock}`;

  // Step 5 — Anthropic call.
  const start = Date.now();
  let result: Awaited<ReturnType<ReturnType<typeof getAnthropic>['messages']['parse']>>;
  try {
    result = await getAnthropic().messages.parse({
      model: ANTHROPIC_MODEL,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      system: [{ type: 'text', text: ASK_SYSTEM_PROMPT }],
      messages: [{ role: 'user', content: userContent }],
      output_config: { format: zodOutputFormat(askAnswerSchema) },
    } as never);
  } catch (e) {
    const errorReason = classifyAnthropicError(e);
    await createSuggestionLog({
      userId,
      kind: 'ask',
      userPrompt: question,
      inventorySnapshotIds: [],
      response: null,
      errorReason,
      model: ANTHROPIC_MODEL,
      latencyMs: Date.now() - start,
      retrievedChunkIds,
    });
    logger.info(
      { event: 'ask', userId, ok: false, errorReason, retrievedCount: chunks.length },
      'anthropic call failed',
    );
    return { ok: false, formError: userFacingMessage(errorReason) };
  }

  const answer = (result as { parsed_output: AskAnswer }).parsed_output;
  const usage = (result as unknown as { usage?: Record<string, number> }).usage ?? {};

  const enrichedCitations = await enrichCitations(answer.citations);
  const enrichedAnswer: EnrichedAskAnswer = {
    answer: stripInlineCitationTags(answer.answer),
    citations: enrichedCitations,
  };

  const log = await createSuggestionLog({
    userId,
    kind: 'ask',
    userPrompt: question,
    inventorySnapshotIds: [],
    response: answer,
    model: ANTHROPIC_MODEL,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheCreationTokens: usage.cache_creation_input_tokens,
    latencyMs: Date.now() - start,
    citationCount: answer.citations.length,
    retrievedChunkIds,
  });

  logger.info(
    {
      event: 'ask',
      userId,
      ok: true,
      retrievedCount: chunks.length,
      citationCount: answer.citations.length,
      latencyMs: Date.now() - start,
    },
    'ask: complete',
  );

  return { ok: true, data: { logId: log.id, answer: enrichedAnswer } };
}

/**
 * For each ATTACHMENT citation the LLM produced, look up the attachment's
 * parent FK and decorate the citation with `parent: { entityType, entityId }`
 * so the UI can render a real deep-link chip (`/items/<parent>?attachment=<aid>`)
 * instead of a non-linked label. Non-attachment citations pass through.
 *
 * Single batched query — one `findMany` covers however many attachments
 * the LLM cited, so this never blows up to N+1.
 */
async function enrichCitations(citations: AskCitation[]): Promise<EnrichedAskCitation[]> {
  const attachmentIds = citations
    .filter((c) => c.entityType === 'ATTACHMENT')
    .map((c) => c.entityId);
  if (attachmentIds.length === 0) return citations;

  const parents = await prisma.attachment.findMany({
    where: { id: { in: attachmentIds } },
    select: {
      id: true,
      itemId: true,
      noteId: true,
      serviceRecordId: true,
      warrantyId: true,
    },
  });
  const byId = new Map(parents.map((p) => [p.id, p]));

  return citations.map((c) => {
    if (c.entityType !== 'ATTACHMENT') return c;
    const p = byId.get(c.entityId);
    if (!p) return c;
    if (p.itemId) return { ...c, parent: { entityType: 'ITEM' as const, entityId: p.itemId } };
    if (p.serviceRecordId)
      return {
        ...c,
        parent: { entityType: 'SERVICE_RECORD' as const, entityId: p.serviceRecordId },
      };
    if (p.warrantyId)
      return { ...c, parent: { entityType: 'WARRANTY' as const, entityId: p.warrantyId } };
    if (p.noteId) return { ...c, parent: { entityType: 'NOTE' as const, entityId: p.noteId } };
    return c;
  });
}
