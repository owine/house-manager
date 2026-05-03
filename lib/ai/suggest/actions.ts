'use server';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { computeNextDueOn } from '@/lib/reminders/recurrence';
import type { ActionResult } from '@/lib/result';
import { enqueueSearchIndex } from '@/lib/search/client';
import { ANTHROPIC_MAX_TOKENS, ANTHROPIC_MODEL, getAnthropic } from '../client';
import { buildSuggestContext, type FocusedItem } from '../context-builder';
import { createSuggestionLog, markAccepted } from '../log';
import { buildSystemBlocks } from '../prompts';
import { checkRateLimit } from '../rate-limit';
import {
  type ProposedChecklistItem,
  type ProposedReminder,
  proposeChecklistResponseSchema,
  proposedReminderSchema,
  proposeRemindersResponseSchema,
} from '../schemas';

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
    console.log(
      JSON.stringify({ event: 'ai.suggest', kind: 'reminders', userId, ok: false, errorReason }),
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

  // Structured log line at the action boundary (per spec observability section).
  // TODO(plan-5): replace with project logger once one exists.
  console.log(
    JSON.stringify({
      event: 'ai.suggest',
      kind: 'reminders',
      userId,
      latencyMs: Date.now() - start,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens,
      ok: true,
    }),
  );

  return { ok: true, data: { logId: log.id, proposals: parsed.proposals } };
}

export function classifyAnthropicError(e: unknown): string {
  const msg = (e as Error)?.message ?? '';
  const status = (e as { status?: number })?.status;
  if (status === 429) return 'rate_limited';
  if (status && status >= 500 && status < 600) return 'upstream_5xx';
  if (msg.toLowerCase().includes('timeout') || msg.toLowerCase().includes('aborted')) {
    return 'timeout';
  }
  if (msg.toLowerCase().includes('zoderror') || msg.toLowerCase().includes('schema')) {
    return 'schema_violation';
  }
  return 'unknown';
}

function userFacingMessage(reason: string): string {
  switch (reason) {
    case 'rate_limited':
      return 'Service busy — try again in a minute.';
    case 'upstream_5xx':
      return "Couldn't reach AI service.";
    case 'timeout':
      return 'Took too long — try again.';
    case 'schema_violation':
      return 'Got an unexpected response — try again.';
    default:
      return 'Something went wrong generating suggestions.';
  }
}

// ─── proposeChecklist ────────────────────────────────────────────────────────

const proposeChecklistInputSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('seasonal'), season: z.enum(['spring', 'summer', 'fall', 'winter']) }),
  z.object({ mode: z.literal('freeform'), freeFormPrompt: z.string().min(3).max(2000) }),
  z.object({ mode: z.literal('append'), forChecklistId: z.string().min(1) }),
]);
export type ProposeChecklistInput = z.infer<typeof proposeChecklistInputSchema>;

export type ProposeChecklistData = {
  logId: string;
  name: string;
  description?: string;
  items: ProposedChecklistItem[];
};

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function buildChecklistUserMessage(input: ProposeChecklistInput, appendingTo?: string): string {
  if (input.mode === 'seasonal') {
    return `Generate a ${input.season} maintenance checklist (5–15 items) tailored to the inventory and house profile. Pick a name like "${capitalize(input.season)} ${new Date().getUTCFullYear()} Maintenance".`;
  }
  if (input.mode === 'freeform') {
    return `${input.freeFormPrompt}\n\nReturn a checklist with a clear name and 1–15 items. Include rationale per item.`;
  }
  return `Suggest 3–10 additional items for the existing checklist "${appendingTo ?? input.forChecklistId}". Keep the existing name in your response — only suggest new items.`;
}

export async function proposeChecklist(
  rawInput: unknown,
): Promise<ActionResult<ProposeChecklistData>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, formError: 'Unauthorized' };
  const userId = session.user.id;

  const parsed = proposeChecklistInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const input = parsed.data;

  let appendingTo: { id: string; name: string } | null = null;
  if (input.mode === 'append') {
    const found = await prisma.checklist.findUnique({
      where: { id: input.forChecklistId },
      select: { id: true, name: true },
    });
    if (!found) return { ok: false, formError: 'Checklist not found.' };
    appendingTo = found;
  }

  const rl = await checkRateLimit(userId);
  if (!rl.allowed) {
    await createSuggestionLog({
      userId,
      kind: 'checklist',
      userPrompt: input.mode === 'freeform' ? input.freeFormPrompt : null,
      inventorySnapshotIds: [],
      response: null,
      errorReason: 'user_rate_limit',
      model: ANTHROPIC_MODEL,
    });
    console.log(
      JSON.stringify({
        event: 'ai.suggest',
        kind: 'checklist',
        userId,
        ok: false,
        errorReason: 'user_rate_limit',
      }),
    );
    return { ok: false, formError: `Hourly limit reached (${rl.used}/10).` };
  }

  const ctx = await buildSuggestContext({ today: new Date() });

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
      messages: [{ role: 'user', content: buildChecklistUserMessage(input, appendingTo?.name) }],
      output_config: { format: zodOutputFormat(proposeChecklistResponseSchema) },
    } as never);
  } catch (e) {
    const errorReason = classifyAnthropicError(e);
    await createSuggestionLog({
      userId,
      kind: 'checklist',
      userPrompt: input.mode === 'freeform' ? input.freeFormPrompt : null,
      inventorySnapshotIds: ctx.inventorySnapshotIds,
      response: null,
      errorReason,
      model: ANTHROPIC_MODEL,
      latencyMs: Date.now() - start,
    });
    console.log(
      JSON.stringify({
        event: 'ai.suggest',
        kind: 'checklist',
        userId,
        ok: false,
        errorReason,
      }),
    );
    return { ok: false, formError: userFacingMessage(errorReason) };
  }

  const parsedResp = (
    result as {
      parsed_output: { name: string; description?: string; items: ProposedChecklistItem[] };
    }
  ).parsed_output;
  const usage = (result as unknown as { usage?: Record<string, number> }).usage ?? {};

  const log = await createSuggestionLog({
    userId,
    kind: 'checklist',
    userPrompt: input.mode === 'freeform' ? input.freeFormPrompt : null,
    inventorySnapshotIds: ctx.inventorySnapshotIds,
    response: parsedResp,
    model: ANTHROPIC_MODEL,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheCreationTokens: usage.cache_creation_input_tokens,
    latencyMs: Date.now() - start,
  });

  console.log(
    JSON.stringify({
      event: 'ai.suggest',
      kind: 'checklist',
      userId,
      latencyMs: Date.now() - start,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens,
      ok: true,
    }),
  );

  return {
    ok: true,
    data: {
      logId: log.id,
      name: parsedResp.name,
      description: parsedResp.description,
      items: parsedResp.items,
    },
  };
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

  // Defence in depth — re-validate every row through the AI schema
  // (the user may have edited title/recurrence inline before saving).
  const validated: ProposedReminder[] = [];
  for (const row of input.accepted) {
    const parsed = proposedReminderSchema.safeParse(row);
    if (!parsed.success) {
      return { ok: false, formError: 'Invalid reminder data.' };
    }
    validated.push(parsed.data);
  }

  const today = new Date();

  const savedIds = await prisma.$transaction(async (tx) => {
    const ids: string[] = [];
    for (const r of validated) {
      const created = await tx.reminder.create({
        data: {
          title: r.title,
          description: r.description ?? null,
          itemId: input.itemId ?? null,
          recurrence: r.recurrence,
          leadTimeDays: r.leadTimeDays,
          nextDueOn: computeNextDueOn(r.recurrence, today),
          notifyUserIds: [userId],
          autoCreateServiceRecord: false,
          active: true,
        },
        select: { id: true },
      });
      ids.push(created.id);
    }
    return ids;
  });

  // Search index after the transaction commits
  for (const id of savedIds) {
    await enqueueSearchIndex('reminder', id, 'upsert');
  }

  await markAccepted(input.logId, savedIds);
  revalidatePath('/reminders');
  if (input.itemId) revalidatePath(`/items/${input.itemId}`);
  return { ok: true, data: { savedIds } };
}
