'use server';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { ChatProposalKind, Prisma } from '@prisma/client';
import { ANTHROPIC_CHAT_MAX_TOKENS, ANTHROPIC_MODEL, getAnthropic } from '@/lib/ai/client';
import { createSuggestionLog } from '@/lib/ai/log';
import { checkRateLimit } from '@/lib/ai/rate-limit';
import { classifyAnthropicError, userFacingMessage } from '@/lib/ai/suggest/_shared';
import { retrieveTopK } from '@/lib/ask/retrieve';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { embedTexts } from '@/lib/embedding/voyage';
import { getEnv } from '@/lib/env';
import { getHouseTimezone } from '@/lib/house-profile/queries';
import { getLogger } from '@/lib/logger';
import type { ActionResult } from '@/lib/result';
import { parseCalendarDate, resolveAnchorDay } from './dates';
import { findDuplicateNote, type NoteTitle } from './dedup';
import { buildSnapshotBlock, CHAT_SYSTEM_PROMPT, type SnapshotInput } from './prompt';
import { getChatSession } from './queries';
import { type Snapshot, validateProposal } from './resolve';
import {
  chatTurnInputSchema,
  chatTurnOutputSchema,
  type ProposalPayload,
  proposalPayloadSchema,
} from './schema';
import { deriveSessionTitle } from './title';

const logger = getLogger('chat.actions');

// Same knob Ask uses for cosine top-k retrieval.
const RETRIEVAL_K = 12;

const NOTE_TOO_LONG_EXPLANATION =
  '\n\n(One proposed note was too long to store well and was dropped — try splitting that topic into its own message.)';

export type ChatTurnProposal = {
  id: string;
  kind: ChatProposalKind;
  targetType: string | null;
  targetId: string | null;
  payload: ProposalPayload;
  status: string;
  baseUpdatedAt: Date | null;
  beforeSnapshot: Prisma.JsonValue | null;
};

export type ChatTurnData = {
  sessionId: string;
  messageId: string;
  reply: string;
  proposals: ChatTurnProposal[];
};

type SurvivingProposal = {
  kind: ChatProposalKind;
  targetType: string;
  targetId: string | null;
  payload: ProposalPayload;
  baseUpdatedAt: Date | null;
  beforeSnapshot: Prisma.JsonValue | null;
};

/** `NOTE (id, title)` view used both for the snapshot block and dedup lookup. */
type NoteRow = NoteTitle;

/**
 * `targetType`/`targetId` for a ChatProposal row. Polymorphic and
 * deliberately no FK (matches Embedding) — targetId is the id of the row a
 * proposal would touch; null for the create kinds, which have no target yet.
 */
function targetFor(p: ProposalPayload): { targetType: string; targetId: string | null } {
  switch (p.kind) {
    case 'CREATE_NOTE':
      return { targetType: 'NOTE', targetId: null };
    case 'UPDATE_NOTE':
      return { targetType: 'NOTE', targetId: p.noteId };
    case 'CREATE_ITEM':
      return { targetType: 'ITEM', targetId: null };
    case 'UPDATE_ITEM':
      return { targetType: 'ITEM', targetId: p.itemId };
    case 'UPDATE_SYSTEM':
      return { targetType: 'SYSTEM', targetId: p.systemId };
    case 'CREATE_SERVICE_RECORD':
      return { targetType: 'SERVICE_RECORD', targetId: null };
  }
}

/**
 * Re-derive every calendar-date field's stored string through
 * `parseCalendarDate` rather than trusting the model's raw string verbatim.
 * `validateProposal` already confirmed each date parses; this pins the exact
 * stored representation to OUR parse of it, never a bare `new Date`.
 */
function normalizeProposalDates(p: ProposalPayload): ProposalPayload {
  switch (p.kind) {
    case 'CREATE_SERVICE_RECORD': {
      const d = parseCalendarDate(p.performedOn.value);
      if (!d) return p; // unreachable: validateProposal already rejected this
      return { ...p, performedOn: { ...p.performedOn, value: d.toISOString().slice(0, 10) } };
    }
    case 'CREATE_ITEM':
    case 'UPDATE_ITEM': {
      if (!p.purchaseDate) return p;
      const d = parseCalendarDate(p.purchaseDate.value);
      if (!d) return p;
      return { ...p, purchaseDate: { ...p.purchaseDate, value: d.toISOString().slice(0, 10) } };
    }
    case 'UPDATE_SYSTEM': {
      if (!p.installDate) return p;
      const d = parseCalendarDate(p.installDate.value);
      if (!d) return p;
      return { ...p, installDate: { ...p.installDate, value: d.toISOString().slice(0, 10) } };
    }
    default:
      return p;
  }
}

/**
 * Re-read the update target ONCE, producing both `baseUpdatedAt` (optimistic
 * concurrency) and `beforeSnapshot` (current values of only the fields this
 * proposal touches) from the same row. Null/null for the create kinds and
 * for the (unreachable in practice) case where the row vanished between
 * validate and here — `validateProposal` already confirmed the id is in the
 * snapshot.
 */
async function captureBeforeState(
  p: ProposalPayload,
): Promise<{ baseUpdatedAt: Date | null; beforeSnapshot: Prisma.JsonValue | null }> {
  switch (p.kind) {
    case 'UPDATE_NOTE': {
      const row = await prisma.note.findUnique({
        where: { id: p.noteId },
        select: { updatedAt: true, title: true, body: true },
      });
      if (!row) return { baseUpdatedAt: null, beforeSnapshot: null };
      const snap: Record<string, unknown> = { body: row.body };
      if (p.title !== undefined) snap.title = row.title;
      return { baseUpdatedAt: row.updatedAt, beforeSnapshot: snap as Prisma.JsonValue };
    }
    case 'UPDATE_ITEM': {
      const row = await prisma.item.findUnique({
        where: { id: p.itemId },
        select: {
          updatedAt: true,
          name: true,
          manufacturer: true,
          model: true,
          serialNumber: true,
          location: true,
          notes: true,
          purchaseDate: true,
        },
      });
      if (!row) return { baseUpdatedAt: null, beforeSnapshot: null };
      const snap: Record<string, unknown> = {};
      if (p.name !== undefined) snap.name = row.name;
      if (p.manufacturer !== undefined) snap.manufacturer = row.manufacturer;
      if (p.model !== undefined) snap.model = row.model;
      if (p.serialNumber !== undefined) snap.serialNumber = row.serialNumber;
      if (p.location !== undefined) snap.location = row.location;
      if (p.notes !== undefined) snap.notes = row.notes;
      if (p.purchaseDate !== undefined) {
        snap.purchaseDate = row.purchaseDate ? row.purchaseDate.toISOString().slice(0, 10) : null;
      }
      return { baseUpdatedAt: row.updatedAt, beforeSnapshot: snap as Prisma.JsonValue };
    }
    case 'UPDATE_SYSTEM': {
      const row = await prisma.system.findUnique({
        where: { id: p.systemId },
        select: {
          updatedAt: true,
          name: true,
          kind: true,
          location: true,
          notes: true,
          installDate: true,
        },
      });
      if (!row) return { baseUpdatedAt: null, beforeSnapshot: null };
      const snap: Record<string, unknown> = {};
      if (p.name !== undefined) snap.name = row.name;
      if (p.kindLabel !== undefined) snap.kindLabel = row.kind;
      if (p.location !== undefined) snap.location = row.location;
      if (p.notes !== undefined) snap.notes = row.notes;
      if (p.installDate !== undefined) {
        snap.installDate = row.installDate ? row.installDate.toISOString().slice(0, 10) : null;
      }
      return { baseUpdatedAt: row.updatedAt, beforeSnapshot: snap as Prisma.JsonValue };
    }
    default:
      return { baseUpdatedAt: null, beforeSnapshot: null };
  }
}

/** True when a shape-check failure is specifically an over-length note body. */
function isNoteTooLong(error: { issues: { path: PropertyKey[]; code: string }[] }): boolean {
  return error.issues.some((issue) => issue.path[0] === 'body' && issue.code === 'too_big');
}

/**
 * Persist one turn: create the session when `sessionId` is absent (touch it
 * otherwise), write the USER message, then the ASSISTANT message carrying
 * `aiSuggestionLogId` and the surviving proposals — all in one transaction.
 * `createSuggestionLog` must have already run: `aiSuggestionLogId` is a
 * forward FK, so writing the message first would leave it permanently null.
 */
async function persistTurn(args: {
  userId: string;
  sessionId: string | undefined;
  turnText: string;
  replyText: string;
  logId: string;
  proposals: SurvivingProposal[];
}): Promise<{ sessionId: string; assistantMessageId: string; proposals: ChatTurnProposal[] }> {
  const { userId, sessionId, turnText, replyText, logId, proposals } = args;

  return prisma.$transaction(async (tx) => {
    const chatSession = sessionId
      ? await tx.chatSession.update({ where: { id: sessionId }, data: {}, select: { id: true } })
      : await tx.chatSession.create({
          data: { userId, title: deriveSessionTitle(turnText) },
          select: { id: true },
        });

    await tx.chatMessage.create({
      data: { sessionId: chatSession.id, role: 'USER', content: turnText },
    });

    const assistantMessage = await tx.chatMessage.create({
      data: {
        sessionId: chatSession.id,
        role: 'ASSISTANT',
        content: replyText,
        aiSuggestionLogId: logId,
        proposals: {
          create: proposals.map((p) => ({
            kind: p.kind,
            targetType: p.targetType,
            targetId: p.targetId,
            payload: p.payload as unknown as Prisma.InputJsonValue,
            baseUpdatedAt: p.baseUpdatedAt,
            beforeSnapshot: p.beforeSnapshot ?? undefined,
          })),
        },
      },
      include: { proposals: true },
    });

    return {
      sessionId: chatSession.id,
      assistantMessageId: assistantMessage.id,
      proposals: assistantMessage.proposals.map((row) => ({
        id: row.id,
        kind: row.kind,
        targetType: row.targetType,
        targetId: row.targetId,
        payload: row.payload as unknown as ProposalPayload,
        status: row.status,
        baseUpdatedAt: row.baseUpdatedAt,
        beforeSnapshot: row.beforeSnapshot,
      })),
    };
  });
}

/**
 * One turn of conversational capture. Pipeline: auth -> env gate -> parse ->
 * rate limit -> embed + retrieve -> snapshot -> Anthropic call -> validate/
 * dedup/rewrite each proposal -> log -> persist session/messages/proposals.
 *
 * Modelled closely on `lib/ask/actions.ts`. Departs from it in one important
 * way: on an Anthropic-call failure we still persist an ASSISTANT
 * ChatMessage (carrying a user-facing error reply and the log link), because
 * this is a conversation thread the user keeps looking at — Ask has no
 * session to write into on failure.
 */
export async function chatTurn(input: unknown): Promise<ActionResult<ChatTurnData>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, formError: 'Unauthorized' };
  const userId = session.user.id;

  const { ASK_ENABLED } = getEnv();
  if (!ASK_ENABLED) return { ok: false, formError: 'Ask is not enabled on this deployment.' };

  const parsed = chatTurnInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { sessionId, messages } = parsed.data;
  const lastTurn = messages[messages.length - 1];
  if (!lastTurn) return { ok: false, formError: 'Empty conversation' };
  const turnText = lastTurn.content.trim();

  // Prior turns are replayed from ChatMessage, not the client-supplied
  // `messages` array — only the LATEST turn (validated above) is trusted.
  let priorMessages: { role: 'user' | 'assistant'; content: string }[] = [];
  if (sessionId) {
    const existing = await getChatSession(sessionId, userId);
    if (!existing) return { ok: false, formError: 'Session not found' };
    priorMessages = existing.messages.map((m) => ({
      role: m.role === 'USER' ? ('user' as const) : ('assistant' as const),
      content: m.content,
    }));
  }

  const rl = await checkRateLimit(userId, 'chat');
  if (!rl.allowed) {
    await createSuggestionLog({
      userId,
      kind: 'chat',
      userPrompt: turnText,
      inventorySnapshotIds: [],
      response: null,
      errorReason: 'user_rate_limit',
      model: ANTHROPIC_MODEL,
    });
    return { ok: false, formError: `Hourly limit reached (${rl.used}/${rl.limit}).` };
  }

  // Embed + retrieve.
  let questionEmbedding: Float32Array;
  try {
    const embeds = await embedTexts([turnText], { inputType: 'query' });
    const first = embeds[0];
    if (!first) throw new Error('voyage returned no embedding');
    questionEmbedding = first;
  } catch (err) {
    logger.error({ err, userId }, 'voyage embed failed');
    await createSuggestionLog({
      userId,
      kind: 'chat',
      userPrompt: turnText,
      inventorySnapshotIds: [],
      response: null,
      errorReason: 'embed_failed',
      model: ANTHROPIC_MODEL,
    });
    return { ok: false, formError: 'Could not process your message. Try again.' };
  }
  const chunks = await retrieveTopK(questionEmbedding, { k: RETRIEVAL_K });
  const retrievedChunkIds = chunks.map((c) => c.embeddingId);
  const contextBlock =
    chunks.length === 0
      ? "(no relevant records were retrieved from the user's content)"
      : chunks
          .map(
            (c, i) =>
              `[chunk ${i + 1}] entityType=${c.entityType} entityId=${c.entityId}\n${c.text}`,
          )
          .join('\n\n---\n\n');
  const latestUserContent = `${turnText}\n\n---\n\nRetrieved context:\n${contextBlock}`;

  // Snapshot: every id the model may legally reference.
  const [items, systems, categories, notes] = await Promise.all([
    prisma.item.findMany({
      where: { archivedAt: null },
      select: { id: true, name: true, location: true, category: { select: { name: true } } },
    }),
    prisma.system.findMany({
      where: { archivedAt: null },
      select: { id: true, name: true, location: true },
    }),
    prisma.category.findMany({ select: { id: true, name: true } }),
    prisma.note.findMany({ select: { id: true, title: true } }),
  ]);
  const noteRows: NoteRow[] = notes;
  const snapshot: Snapshot = {
    itemIds: new Set(items.map((i) => i.id)),
    systemIds: new Set(systems.map((s) => s.id)),
    categoryIds: new Set(categories.map((c) => c.id)),
    noteIds: new Set(noteRows.map((n) => n.id)),
  };

  const tz = await getHouseTimezone();
  const anchorDay = resolveAnchorDay(new Date(), tz);
  const snapshotInput: SnapshotInput = {
    anchorDay,
    items: items.map((i) => ({
      id: i.id,
      name: i.name,
      categoryName: i.category.name,
      location: i.location,
    })),
    systems: systems.map((s) => ({ id: s.id, name: s.name, location: s.location })),
    categories,
    notes: noteRows,
  };
  const snapshotBlock = buildSnapshotBlock(snapshotInput);

  const anthropicMessages = [
    ...priorMessages,
    { role: 'user' as const, content: latestUserContent },
  ];

  const start = Date.now();
  let result: Awaited<ReturnType<ReturnType<typeof getAnthropic>['messages']['parse']>>;
  try {
    result = await getAnthropic().messages.parse({
      model: ANTHROPIC_MODEL,
      max_tokens: ANTHROPIC_CHAT_MAX_TOKENS,
      system: [
        { type: 'text', text: CHAT_SYSTEM_PROMPT },
        { type: 'text', text: snapshotBlock, cache_control: { type: 'ephemeral' } },
      ],
      messages: anthropicMessages,
      output_config: { format: zodOutputFormat(chatTurnOutputSchema) },
    } as never);
  } catch (e) {
    const errorReason = classifyAnthropicError(e);
    const log = await createSuggestionLog({
      userId,
      kind: 'chat',
      userPrompt: turnText,
      inventorySnapshotIds: [],
      response: null,
      errorReason,
      model: ANTHROPIC_MODEL,
      latencyMs: Date.now() - start,
      retrievedChunkIds,
    });
    logger.info({ event: 'chat', userId, ok: false, errorReason }, 'anthropic call failed');

    const errorReply = userFacingMessage(errorReason);
    await persistTurn({
      userId,
      sessionId,
      turnText,
      replyText: errorReply,
      logId: log.id,
      proposals: [],
    });
    return { ok: false, formError: errorReply };
  }

  const rawOutput = (result as { parsed_output: { reply: string; proposals: unknown[] } })
    .parsed_output;
  const usage = (result as unknown as { usage?: Record<string, number> }).usage ?? {};

  let reply = rawOutput.reply;
  let droppedForLength = false;
  const survivors: SurvivingProposal[] = [];

  for (const raw of rawOutput.proposals) {
    // Do NOT trust `result.parsed_output`'s TS type as a runtime guarantee —
    // the Anthropic SDK's own zod re-validation happens inside
    // `output_config.format.parse`, which only real API responses go
    // through. Re-parsing here is what makes the over-length-note and
    // hallucinated-id drops actually testable, and is cheap insurance in
    // production too.
    const shapeCheck = proposalPayloadSchema.safeParse(raw);
    if (!shapeCheck.success) {
      if (isNoteTooLong(shapeCheck.error)) droppedForLength = true;
      logger.info({ event: 'chat.proposal.dropped', reason: 'invalid_shape' }, 'dropped proposal');
      continue;
    }
    let p = shapeCheck.data;

    const v = validateProposal(p, snapshot);
    if (!v.ok) {
      logger.info({ event: 'chat.proposal.dropped', reason: v.reason }, 'dropped proposal');
      continue;
    }

    if (p.kind === 'CREATE_NOTE') {
      const match = findDuplicateNote(p.title.value, noteRows);
      if (match) {
        p = { kind: 'UPDATE_NOTE', noteId: match.id, title: p.title, body: p.body };
      }
    }

    p = normalizeProposalDates(p);
    const { targetType, targetId } = targetFor(p);
    const { baseUpdatedAt, beforeSnapshot } = await captureBeforeState(p);

    survivors.push({
      kind: p.kind,
      targetType,
      targetId,
      payload: p,
      baseUpdatedAt,
      beforeSnapshot,
    });
  }

  if (droppedForLength) reply += NOTE_TOO_LONG_EXPLANATION;

  // createSuggestionLog MUST run before persistTurn's ChatMessage write:
  // ChatMessage.aiSuggestionLogId is a forward FK.
  const log = await createSuggestionLog({
    userId,
    kind: 'chat',
    userPrompt: turnText,
    inventorySnapshotIds: [],
    response: { reply: rawOutput.reply, proposals: rawOutput.proposals } as Prisma.InputJsonValue,
    model: ANTHROPIC_MODEL,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheCreationTokens: usage.cache_creation_input_tokens,
    latencyMs: Date.now() - start,
    retrievedChunkIds,
  });

  const {
    sessionId: finalSessionId,
    assistantMessageId,
    proposals,
  } = await persistTurn({
    userId,
    sessionId,
    turnText,
    replyText: reply,
    logId: log.id,
    proposals: survivors,
  });

  logger.info(
    {
      event: 'chat',
      userId,
      ok: true,
      proposalCount: survivors.length,
      latencyMs: Date.now() - start,
    },
    'chat: turn complete',
  );

  return {
    ok: true,
    data: { sessionId: finalSessionId, messageId: assistantMessageId, reply, proposals },
  };
}
