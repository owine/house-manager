'use server';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { enqueueEmbed } from '@/lib/embedding/enqueue';
import { getHouseTimezone } from '@/lib/house-profile/queries';
import { getLogger } from '@/lib/logger';
import type { ActionResult } from '@/lib/result';
import { enqueueSearchIndex } from '@/lib/search/client';
import { startOfDayUtc } from '@/lib/time/tz';
import { ANTHROPIC_MAX_TOKENS, ANTHROPIC_MODEL, getAnthropic } from '../client';
import { buildSuggestContext } from '../context-builder';
import { createSuggestionLog, markAccepted } from '../log';
import { buildSystemBlocks } from '../prompts';
import { checkRateLimit } from '../rate-limit';
import { type ProposedChecklistItem, proposeChecklistResponseSchema } from '../schemas';
import { ChecklistNotFoundError, classifyAnthropicError, userFacingMessage } from './_shared';

const logger = getLogger('ai.suggest.checklist');

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
    logger.info(
      { event: 'ai.suggest', kind: 'checklist', userId, ok: false, errorReason: 'user_rate_limit' },
      'rate-limited',
    );
    return { ok: false, formError: `Hourly limit reached (${rl.used}/10).` };
  }

  // `today` is rendered into the prompt as a UTC day (`toISOString().slice(0,10)`)
  // and drives seasonForDate. Passing a raw instant told the model TOMORROW's
  // date every evening after 7pm Chicago. Reduce it to the house day first.
  const houseToday = startOfDayUtc(new Date(), await getHouseTimezone());

  const ctx = await buildSuggestContext({ today: houseToday });

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
    logger.info(
      { event: 'ai.suggest', kind: 'checklist', userId, ok: false, errorReason },
      'anthropic call failed',
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

  logger.info(
    {
      event: 'ai.suggest',
      kind: 'checklist',
      userId,
      latencyMs: Date.now() - start,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens,
      ok: true,
    },
    'success',
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

// ─── saveAcceptedChecklist ───────────────────────────────────────────────────

export async function saveAcceptedChecklist(input: {
  logId: string;
  name: string;
  description?: string;
  items: ProposedChecklistItem[];
  appendToChecklistId?: string;
}): Promise<ActionResult<{ checklistId: string }>> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  if (!input.items || input.items.length === 0) {
    return { ok: false, formError: 'No items selected.' };
  }
  // `name` required for the create path; ignored for the append path.
  if (!input.appendToChecklistId && (!input.name || input.name.trim().length === 0)) {
    return { ok: false, formError: 'Checklist name is required.' };
  }

  let checklistId: string;
  try {
    checklistId = await prisma.$transaction(async (tx) => {
      let target: { id: string; nextPosition: number };

      if (input.appendToChecklistId) {
        const existing = await tx.checklist.findUnique({
          where: { id: input.appendToChecklistId },
          include: { items: { orderBy: { position: 'desc' }, take: 1 } },
        });
        if (!existing) throw new ChecklistNotFoundError();
        target = {
          id: existing.id,
          nextPosition: (existing.items[0]?.position ?? -1) + 1,
        };
      } else {
        const created = await tx.checklist.create({
          data: { name: input.name, description: input.description },
        });
        target = { id: created.id, nextPosition: 0 };
      }

      for (let i = 0; i < input.items.length; i++) {
        const row = input.items[i];
        await tx.checklistItem.create({
          data: {
            checklistId: target.id,
            position: target.nextPosition + i,
            title: row.title,
            itemId: row.itemId,
          },
        });
      }

      return target.id;
    });
  } catch (e) {
    if (e instanceof ChecklistNotFoundError) {
      return { ok: false, formError: 'Checklist not found.' };
    }
    throw e;
  }

  // Search-index sync.
  try {
    await enqueueSearchIndex('checklist', checklistId, 'upsert');
  } catch (e) {
    logger.warn(
      {
        event: 'ai.suggest.enqueueSearchIndex.failed',
        kind: 'checklist',
        checklistId,
        err: (e as Error).message,
      },
      'enqueueSearchIndex failed',
    );
  }
  await enqueueEmbed('CHECKLIST_ITEM', checklistId);

  try {
    await markAccepted(input.logId, [checklistId]);
  } catch (e) {
    logger.warn(
      { event: 'ai.suggest.markAccepted.failed', logId: input.logId, err: (e as Error).message },
      'markAccepted failed',
    );
  }

  revalidatePath('/checklists');
  revalidatePath(`/checklists/${checklistId}`);
  return { ok: true, data: { checklistId } };
}
