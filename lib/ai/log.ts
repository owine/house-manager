import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { SYSTEM_PROMPT_VERSION } from './prompts';

export type CreateLogInput = {
  userId: string;
  kind: 'reminders' | 'checklist';
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
};

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
