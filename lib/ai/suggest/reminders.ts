'use server';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { getLogger } from '@/lib/logger';
import { computeNextDueOn } from '@/lib/reminders/recurrence';
import type { ActionResult } from '@/lib/result';
import { enqueueSearchIndex } from '@/lib/search/client';
import { ANTHROPIC_MAX_TOKENS, ANTHROPIC_MODEL, getAnthropic } from '../client';
import { buildSuggestContext, type FocusedItem } from '../context-builder';
import { createSuggestionLog, markAccepted } from '../log';
import { buildSystemBlocks } from '../prompts';
import { checkRateLimit } from '../rate-limit';
import {
  type ProposedReminder,
  proposedReminderSchema,
  proposeRemindersResponseSchema,
} from '../schemas';
import { classifyAnthropicError, userFacingMessage } from './_shared';

const logger = getLogger('ai.suggest.reminders');

export type ProposeRemindersData = {
  logId: string;
  proposals: ProposedReminder[];
};

function buildReminderUserMessage(focused: FocusedItem | null): string {
  if (focused) {
    return `Generate up to 5 maintenance reminders for this item:
id=${focused.id}
name="${focused.name}"
category=${focused.categoryName}
manufacturer=${focused.manufacturer ?? '—'}
model=${focused.model ?? '—'}

Return reminders that are specific to this item. Use the inventory only for cross-references.`;
  }
  return `Generate up to 5 broad household maintenance reminders based on the inventory and house profile.`;
}

export async function proposeReminders(input: {
  itemId?: string;
}): Promise<ActionResult<ProposeRemindersData>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, formError: 'Unauthorized' };
  const userId = session.user.id;

  const rl = await checkRateLimit(userId);
  if (!rl.allowed) {
    await createSuggestionLog({
      userId,
      kind: 'reminders',
      userPrompt: null,
      inventorySnapshotIds: [],
      response: null,
      errorReason: 'user_rate_limit',
      model: ANTHROPIC_MODEL,
    });
    logger.info(
      { event: 'ai.suggest', kind: 'reminders', userId, ok: false, errorReason: 'user_rate_limit' },
      'rate-limited',
    );
    return { ok: false, formError: `Hourly limit reached (${rl.used}/10).` };
  }

  const ctx = await buildSuggestContext({ today: new Date(), focusedItemId: input.itemId });

  const start = Date.now();
  let result: Awaited<ReturnType<ReturnType<typeof getAnthropic>['messages']['parse']>>;
  try {
    result = await getAnthropic().messages.parse({
      model: ANTHROPIC_MODEL,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      system: buildSystemBlocks({
        profile: ctx.profile,
        today: new Date(),
        inventory: ctx.inventory,
      }),
      messages: [{ role: 'user', content: buildReminderUserMessage(ctx.focusedItem) }],
      output_config: { format: zodOutputFormat(proposeRemindersResponseSchema) },
    } as never);
  } catch (e) {
    const errorReason = classifyAnthropicError(e);
    await createSuggestionLog({
      userId,
      kind: 'reminders',
      userPrompt: null,
      inventorySnapshotIds: ctx.inventorySnapshotIds,
      response: null,
      errorReason,
      model: ANTHROPIC_MODEL,
      latencyMs: Date.now() - start,
    });
    logger.info(
      { event: 'ai.suggest', kind: 'reminders', userId, ok: false, errorReason },
      'anthropic call failed',
    );
    return { ok: false, formError: userFacingMessage(errorReason) };
  }

  const parsed = (result as { parsed_output: { proposals: ProposedReminder[] } }).parsed_output;
  const usage = (result as unknown as { usage?: Record<string, number> }).usage ?? {};

  const log = await createSuggestionLog({
    userId,
    kind: 'reminders',
    userPrompt: null,
    inventorySnapshotIds: ctx.inventorySnapshotIds,
    response: parsed,
    model: ANTHROPIC_MODEL,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheCreationTokens: usage.cache_creation_input_tokens,
    latencyMs: Date.now() - start,
  });

  logger.info(
    {
      event: 'ai.suggest',
      kind: 'reminders',
      userId,
      latencyMs: Date.now() - start,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens,
      ok: true,
    },
    'success',
  );

  return { ok: true, data: { logId: log.id, proposals: parsed.proposals } };
}

// ─── saveAcceptedReminders ───────────────────────────────────────────────────

export async function saveAcceptedReminders(input: {
  logId: string;
  accepted: ProposedReminder[];
  itemId?: string;
}): Promise<ActionResult<{ savedIds: string[] }>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, formError: 'Unauthorized' };
  const userId = session.user.id;

  if (!input.accepted || input.accepted.length === 0) {
    return { ok: false, formError: 'No reminders selected.' };
  }

  // Defence in depth — re-validate all rows at once through the AI schema
  // (the user may have edited title/recurrence inline before saving).
  const parsedAll = z.array(proposedReminderSchema).safeParse(input.accepted);
  if (!parsedAll.success) {
    return { ok: false, formError: 'Invalid reminder data.' };
  }
  const validated = parsedAll.data;

  const today = new Date();

  const savedIds = await prisma.$transaction(async (tx) => {
    const ids: string[] = [];
    for (const r of validated) {
      const nextDueOn = computeNextDueOn(r.recurrence, today);
      const created = await tx.reminder.create({
        data: {
          title: r.title,
          description: r.description ?? null,
          recurrence: r.recurrence,
          leadTimeDays: r.leadTimeDays,
          notifyUserIds: [userId],
          autoCreateServiceRecord: false,
          active: true,
          // If no itemId is supplied, the reminder is created without targets
          // (an unattached suggestion). The caller is expected to wire
          // targets later via the edit form.
          ...(input.itemId ? { targets: { create: [{ itemId: input.itemId, nextDueOn }] } } : {}),
        },
        select: { id: true },
      });
      ids.push(created.id);
    }
    return ids;
  });

  // Search index after the transaction commits — best-effort, don't fail the save
  try {
    await Promise.all(savedIds.map((id) => enqueueSearchIndex('reminder', id, 'upsert')));
  } catch (e) {
    logger.warn(
      {
        event: 'ai.suggest.enqueueSearchIndex.failed',
        kind: 'reminders',
        err: (e as Error).message,
      },
      'enqueueSearchIndex failed',
    );
  }

  try {
    await markAccepted(input.logId, savedIds);
  } catch (e) {
    logger.warn(
      { event: 'ai.suggest.markAccepted.failed', logId: input.logId, err: (e as Error).message },
      'markAccepted failed',
    );
  }

  revalidatePath('/reminders');
  if (input.itemId) revalidatePath(`/items/${input.itemId}`);
  return { ok: true, data: { savedIds } };
}
