import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { SYSTEM_PROMPT_VERSION } from './prompts';

export type SuggestionKind =
  | 'reminders'
  | 'checklist'
  | 'incoming-email-extract'
  | 'incoming-email-classify'
  | 'ask'
  // The chat turn's SECOND model call (lib/chat/parts-extract.ts). Its own
  // kind, not 'chat': the hourly budget in lib/ai/rate-limit.ts counts 'chat'
  // rows, so logging both calls under one kind would halve the number of turns
  // a user gets. Separate rows also keep the two calls' token costs legible.
  | 'chat-parts'
  | 'chat';

export type CreateLogInput = {
  userId: string;
  kind: SuggestionKind;
  userPrompt: string | null;
  inventorySnapshotIds: string[];
  response: Prisma.InputJsonValue | null;
  errorReason?: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  latencyMs?: number;
  // Plan 4c — populated only for `kind: 'ask'`. Other kinds leave these null.
  citationCount?: number;
  retrievedChunkIds?: string[];
};

/**
 * The four token counts every call site logs, mapped off the SDK's `usage`.
 *
 * The cache counters are `number | null` on the SDK type — null when the
 * request had no `cache_control` breakpoint at all, 0 when it had one that
 * didn't hit. `CreateLogInput` takes `number | undefined`, so the coalesce is
 * load-bearing rather than cosmetic, and doing it here keeps the distinction
 * from being re-derived (or quietly cast away) at each call site.
 */
export function usageLogFields(
  usage:
    | {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
      }
    | undefined,
): Pick<
  CreateLogInput,
  'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens'
> {
  // Accepts undefined so call sites never need a ternary. `Message.usage` is
  // non-optional on the SDK type, so in practice this only fires where a local
  // `usage` variable is declared before the try that assigns it and TypeScript
  // cannot narrow it afterwards.
  if (!usage) return {};
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? undefined,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? undefined,
  };
}

export async function createSuggestionLog(input: CreateLogInput) {
  return prisma.aISuggestionLog.create({
    data: {
      userId: input.userId,
      kind: input.kind,
      systemPromptVersion: SYSTEM_PROMPT_VERSION,
      userPrompt: input.userPrompt,
      inventorySnapshotIds: input.inventorySnapshotIds,
      response: input.response ?? Prisma.DbNull,
      errorReason: input.errorReason,
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadTokens: input.cacheReadTokens,
      cacheCreationTokens: input.cacheCreationTokens,
      latencyMs: input.latencyMs,
      citationCount: input.citationCount,
      retrievedChunkIds: input.retrievedChunkIds ?? [],
    },
  });
}

/**
 * Append `ids` to the existing acceptedItemIds JSONB array for `logId`.
 * Prisma doesn't expose jsonb_set / array_append, so we use $executeRaw.
 */
export async function markAccepted(logId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await prisma.$executeRaw`
    UPDATE "AISuggestionLog"
    SET "acceptedItemIds" =
      COALESCE("acceptedItemIds", '[]'::jsonb) || ${JSON.stringify(ids)}::jsonb
    WHERE id = ${logId}
  `;
}
