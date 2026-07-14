'use server';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { getHouseTimezone } from '@/lib/house-profile/queries';
import { getLogger } from '@/lib/logger';
import { computeNextDueOn } from '@/lib/reminders/recurrence';
import { parseRecurrence } from '@/lib/reminders/schema';
import type { ActionResult } from '@/lib/result';
import { enqueueSearchIndex } from '@/lib/search/client';
import { startOfDayUtc } from '@/lib/time/tz';
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

  // `today` is rendered into the prompt as a UTC day (`toISOString().slice(0,10)`)
  // and drives seasonForDate. Passing a raw instant told the model TOMORROW's
  // date every evening after 7pm Chicago. Reduce it to the house day first.
  const houseToday = startOfDayUtc(new Date(), await getHouseTimezone());

  const ctx = await buildSuggestContext({ today: houseToday, focusedItemId: input.itemId });

  const start = Date.now();
  let result: Awaited<ReturnType<ReturnType<typeof getAnthropic>['messages']['parse']>>;
  try {
    result = await getAnthropic().messages.parse({
      model: ANTHROPIC_MODEL,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      system: buildSystemBlocks({
        profile: ctx.profile,
        today: houseToday,
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

  // Reminders must have at least one target — otherwise the worker (which
  // queries reminder_targets) will silently never fire them. The AI flow
  // only supports an itemId today; broader targeting requires the user to
  // attach via the edit form post-save (which we don't expose here).
  if (!input.itemId) {
    return {
      ok: false,
      formError:
        'AI-suggested reminders must be attached to an item. Open them from an item page, or attach a target via the edit form.',
    };
  }

  // Defence in depth — re-validate all rows at once through the AI schema
  // (the user may have edited title/recurrence inline before saving).
  const parsedAll = z.array(proposedReminderSchema).safeParse(input.accepted);
  if (!parsedAll.success) {
    return { ok: false, formError: 'Invalid reminder data.' };
  }
  const validated = parsedAll.data;

  // Seed the recurrence from the HOUSE day. A raw instant anchored an
  // evening-created reminder to tomorrow (8pm Chicago is already the next UTC
  // day), so its first occurrence landed a day late.
  const today = startOfDayUtc(new Date(), await getHouseTimezone());
  const itemId = input.itemId;

  const savedIds = await prisma.$transaction(async (tx) => {
    const ids: string[] = [];
    for (const r of validated) {
      const recurrence = parseRecurrence(r.recurrence);
      const nextDueOn = computeNextDueOn(recurrence, today);
      const created = await tx.reminder.create({
        data: {
          title: r.title,
          description: r.description ?? null,
          recurrence,
          leadTimeDays: r.leadTimeDays,
          notifyUserIds: [userId],
          autoCreateServiceRecord: false,
          active: true,
          targets: { create: [{ itemId, nextDueOn }] },
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
