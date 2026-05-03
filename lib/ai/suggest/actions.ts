'use server';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { auth } from '@/lib/auth';
import type { ActionResult } from '@/lib/result';
import { ANTHROPIC_MAX_TOKENS, ANTHROPIC_MODEL, getAnthropic } from '../client';
import { buildSuggestContext, type FocusedItem } from '../context-builder';
import { createSuggestionLog } from '../log';
import { buildSystemBlocks } from '../prompts';
import { checkRateLimit } from '../rate-limit';
import { type ProposedReminder, proposeRemindersResponseSchema } from '../schemas';

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
