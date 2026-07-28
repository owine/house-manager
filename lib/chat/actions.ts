'use server';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { ChatProposal, ChatProposalKind, Prisma } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { ANTHROPIC_CHAT_MAX_TOKENS, ANTHROPIC_MODEL, getAnthropic } from '@/lib/ai/client';
import { createSuggestionLog } from '@/lib/ai/log';
import { checkRateLimit } from '@/lib/ai/rate-limit';
import { classifyAnthropicError, userFacingMessage } from '@/lib/ai/suggest/_shared';
import { retrieveTopK } from '@/lib/ask/retrieve';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { enqueueItemRenameCascade, enqueueSystemRenameCascade } from '@/lib/embedding/cascade';
import { enqueueEmbed } from '@/lib/embedding/enqueue';
import { embedTexts } from '@/lib/embedding/voyage';
import { getEnv } from '@/lib/env';
import { getHouseTimezone } from '@/lib/house-profile/queries';
import { getLogger } from '@/lib/logger';
import type { ActionResult } from '@/lib/result';
import { enqueueSearchIndex } from '@/lib/search/client';
import { parseCalendarDate, resolveAnchorDay } from './dates';
import { findDuplicateNote, type NoteTitle } from './dedup';
import { buildSnapshotBlock, CHAT_SYSTEM_PROMPT, type SnapshotInput } from './prompt';
import { getChatSession } from './queries';
import { type Snapshot, validateProposal } from './resolve';
import {
  chatTurnInputSchema,
  chatTurnOutputSchema,
  type ProposalPayload,
  parseStoredPayload,
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
    const log = await createSuggestionLog({
      userId,
      kind: 'chat',
      userPrompt: turnText,
      inventorySnapshotIds: [],
      response: null,
      errorReason: 'embed_failed',
      model: ANTHROPIC_MODEL,
    });
    // Same reasoning as the Anthropic-failure branch below: this is a
    // conversation thread the user keeps looking at, not a one-shot
    // question. Without persisting here, the user's own message would
    // vanish from the thread on reload — they'd see an error toast, reload,
    // and their text would be gone.
    const errorReply = 'Could not process your message. Try again.';
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

// ─────────────────────────────────────────────────────────────────────────
// Apply / reject / refresh
// ─────────────────────────────────────────────────────────────────────────

const proposalIdSchema = z.string().min(1);

/**
 * Proposals are reachable by id and the entities they write are house-global
 * — the ownership check is folded into the query itself (message -> session
 * -> userId) rather than fetched-then-compared, so a proposal belonging to
 * another user is indistinguishable from a missing one, same discipline as
 * `getChatSession`.
 */
async function loadOwnedProposal(id: string, userId: string): Promise<ChatProposal | null> {
  return prisma.chatProposal.findFirst({
    where: { id, message: { session: { userId } } },
  });
}

/** Loose object guard for a Json column read back as `Prisma.JsonValue`. */
function asRecord(json: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return json && typeof json === 'object' && !Array.isArray(json)
    ? (json as Record<string, unknown>)
    : {};
}

/**
 * Pull `{ field: source }` out of every provenanced (`{ value, source }`)
 * field on a payload. Non-provenanced keys (ids, booleans, arrays) don't
 * match the shape and are skipped automatically — this is why the same
 * helper works unmodified across CREATE_ITEM / UPDATE_ITEM / UPDATE_SYSTEM,
 * whose provenanced fields differ.
 */
function extractProvenance(payload: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(payload)) {
    if (val && typeof val === 'object' && 'value' in val && 'source' in val) {
      out[key] = (val as { source: string }).source;
    }
  }
  return out;
}

/**
 * Merge new field-provenance into a row's existing `metadata`, preserving
 * both non-provenance metadata keys and prior provenance entries for fields
 * this proposal doesn't touch. New entries win on conflict — a field the
 * model re-proposes gets its freshest provenance.
 */
function mergeProvenanceMetadata(
  existingMetadata: Prisma.JsonValue | null | undefined,
  newProvenance: Record<string, string>,
): Prisma.InputJsonValue {
  const existing = asRecord(existingMetadata);
  const existingProvenance = asRecord(existing._provenance as Prisma.JsonValue) as Record<
    string,
    string
  >;
  return {
    ...existing,
    _provenance: { ...existingProvenance, ...newProvenance },
  } as Prisma.InputJsonValue;
}

type TerminalStatus = 'STALE' | 'ORPHANED';

/**
 * Re-read an update target's `updatedAt`, comparing it against the
 * proposal's `baseUpdatedAt`. Null row -> ORPHANED (deleted underneath);
 * mismatched `updatedAt` -> STALE (changed underneath). Neither is logged as
 * an error — both are expected, user-facing outcomes of concurrent editing.
 */
function checkFreshness(
  row: { updatedAt: Date } | null,
  baseUpdatedAt: Date | null,
): { ok: true } | { ok: false; status: TerminalStatus; formError: string } {
  if (!row) {
    return { ok: false, status: 'ORPHANED', formError: 'The record this refers to was deleted.' };
  }
  if (baseUpdatedAt && row.updatedAt.getTime() !== baseUpdatedAt.getTime()) {
    return {
      ok: false,
      status: 'STALE',
      formError:
        'This record changed since the proposal was made. Refresh it to review the new values.',
    };
  }
  return { ok: true };
}

/** Mark a proposal terminal (STALE / ORPHANED) and surface its message. Never throws. */
async function markTerminal(
  id: string,
  outcome: { status: TerminalStatus; formError: string },
): Promise<ActionResult<never>> {
  await prisma.chatProposal.update({ where: { id }, data: { status: outcome.status } });
  return { ok: false, formError: outcome.formError };
}

async function applyCreateNote(
  id: string,
  payload: Extract<ProposalPayload, { kind: 'CREATE_NOTE' }>,
): Promise<ActionResult<{ id: string }>> {
  let note: { id: string };
  try {
    note = await prisma.note.create({
      data: {
        title: payload.title.value,
        body: payload.body.value,
        itemId: payload.itemId,
      },
      select: { id: true },
    });
  } catch (err) {
    logger.warn({ err, proposalId: id }, 'chat.apply: create note failed');
    return { ok: false, formError: 'Could not create the note — it may reference a deleted item.' };
  }

  await enqueueSearchIndex('note', note.id, 'upsert');
  await enqueueEmbed('NOTE', note.id);

  await prisma.chatProposal.update({
    where: { id },
    data: { status: 'ACCEPTED', appliedEntityId: note.id, appliedAt: new Date() },
  });

  revalidatePath('/notes');
  revalidatePath('/dashboard');
  if (payload.itemId) revalidatePath(`/items/${payload.itemId}`);
  revalidatePath('/ask');

  return { ok: true, data: { id: note.id } };
}

async function applyUpdateNote(
  id: string,
  payload: Extract<ProposalPayload, { kind: 'UPDATE_NOTE' }>,
  baseUpdatedAt: Date | null,
): Promise<ActionResult<{ id: string }>> {
  const row = await prisma.note.findUnique({
    where: { id: payload.noteId },
    select: { updatedAt: true, itemId: true },
  });
  const fresh = checkFreshness(row, baseUpdatedAt);
  if (!fresh.ok) return markTerminal(id, fresh);

  try {
    await prisma.note.update({
      where: { id: payload.noteId },
      data: {
        body: payload.body.value,
        ...(payload.title !== undefined ? { title: payload.title.value } : {}),
      },
    });
  } catch (err) {
    logger.warn({ err, proposalId: id }, 'chat.apply: update note failed');
    return { ok: false, formError: 'Could not update the note.' };
  }

  await enqueueSearchIndex('note', payload.noteId, 'upsert');
  await enqueueEmbed('NOTE', payload.noteId);

  await prisma.chatProposal.update({
    where: { id },
    data: { status: 'ACCEPTED', appliedEntityId: payload.noteId, appliedAt: new Date() },
  });

  revalidatePath('/notes');
  revalidatePath(`/notes/${payload.noteId}`);
  revalidatePath('/dashboard');
  if (row?.itemId) revalidatePath(`/items/${row.itemId}`);
  revalidatePath('/ask');

  return { ok: true, data: { id: payload.noteId } };
}

async function applyCreateItem(
  id: string,
  payload: Extract<ProposalPayload, { kind: 'CREATE_ITEM' }>,
): Promise<ActionResult<{ id: string }>> {
  const provenance = extractProvenance(payload);
  let item: { id: string };
  try {
    item = await prisma.item.create({
      data: {
        name: payload.name.value,
        categoryId: payload.categoryId,
        manufacturer: payload.manufacturer?.value ?? null,
        model: payload.model?.value ?? null,
        serialNumber: payload.serialNumber?.value ?? null,
        location: payload.location?.value ?? null,
        purchaseDate: payload.purchaseDate ? parseCalendarDate(payload.purchaseDate.value) : null,
        metadata: mergeProvenanceMetadata(null, provenance),
      },
      select: { id: true },
    });
  } catch (err) {
    logger.warn({ err, proposalId: id }, 'chat.apply: create item failed');
    return {
      ok: false,
      formError: 'Could not create the item — it may reference a deleted category.',
    };
  }

  await enqueueSearchIndex('item', item.id, 'upsert');
  await enqueueEmbed('ITEM', item.id);

  await prisma.chatProposal.update({
    where: { id },
    data: { status: 'ACCEPTED', appliedEntityId: item.id, appliedAt: new Date() },
  });

  revalidatePath('/items');
  revalidatePath('/dashboard');
  revalidatePath('/ask');

  return { ok: true, data: { id: item.id } };
}

async function applyUpdateItem(
  id: string,
  payload: Extract<ProposalPayload, { kind: 'UPDATE_ITEM' }>,
  baseUpdatedAt: Date | null,
): Promise<ActionResult<{ id: string }>> {
  const row = await prisma.item.findUnique({
    where: { id: payload.itemId },
    select: { updatedAt: true, metadata: true },
  });
  const fresh = checkFreshness(row, baseUpdatedAt);
  if (!fresh.ok) return markTerminal(id, fresh);

  const provenance = extractProvenance(payload);
  const data: Record<string, unknown> = {
    metadata: mergeProvenanceMetadata(row?.metadata, provenance),
  };
  if (payload.name !== undefined) data.name = payload.name.value;
  if (payload.manufacturer !== undefined) data.manufacturer = payload.manufacturer.value;
  if (payload.model !== undefined) data.model = payload.model.value;
  if (payload.serialNumber !== undefined) data.serialNumber = payload.serialNumber.value;
  if (payload.location !== undefined) data.location = payload.location.value;
  if (payload.notes !== undefined) data.notes = payload.notes.value;
  if (payload.purchaseDate !== undefined) {
    data.purchaseDate = parseCalendarDate(payload.purchaseDate.value);
  }

  try {
    await prisma.item.update({ where: { id: payload.itemId }, data });
  } catch (err) {
    logger.warn({ err, proposalId: id }, 'chat.apply: update item failed');
    return { ok: false, formError: 'Could not update the item.' };
  }

  await enqueueSearchIndex('item', payload.itemId, 'upsert');
  await enqueueEmbed('ITEM', payload.itemId);
  // Unconditional — no `if (nameChanged)` guard. The embed worker hashes
  // canonical text and skips no-op re-embeds, so calling this on every
  // UPDATE_ITEM apply (not just renames) is safe and cheap. Omitting it
  // compiles fine and silently leaves every child note/service-record/
  // warranty embedding carrying the item's old name.
  await enqueueItemRenameCascade(payload.itemId);

  await prisma.chatProposal.update({
    where: { id },
    data: { status: 'ACCEPTED', appliedEntityId: payload.itemId, appliedAt: new Date() },
  });

  revalidatePath('/items');
  revalidatePath(`/items/${payload.itemId}`);
  revalidatePath('/dashboard');
  revalidatePath('/ask');

  return { ok: true, data: { id: payload.itemId } };
}

async function applyUpdateSystem(
  id: string,
  payload: Extract<ProposalPayload, { kind: 'UPDATE_SYSTEM' }>,
  baseUpdatedAt: Date | null,
): Promise<ActionResult<{ id: string }>> {
  const row = await prisma.system.findUnique({
    where: { id: payload.systemId },
    select: { updatedAt: true, metadata: true },
  });
  const fresh = checkFreshness(row, baseUpdatedAt);
  if (!fresh.ok) return markTerminal(id, fresh);

  const provenance = extractProvenance(payload);
  const data: Record<string, unknown> = {
    metadata: mergeProvenanceMetadata(row?.metadata, provenance),
  };
  if (payload.name !== undefined) data.name = payload.name.value;
  if (payload.kindLabel !== undefined) data.kind = payload.kindLabel.value;
  if (payload.location !== undefined) data.location = payload.location.value;
  if (payload.notes !== undefined) data.notes = payload.notes.value;
  if (payload.installDate !== undefined) {
    data.installDate = parseCalendarDate(payload.installDate.value);
  }

  try {
    // Deliberately bypasses updateSystemWithIdSchema — it does not accept
    // `metadata`, and this path writes it directly via prisma.system.update.
    await prisma.system.update({ where: { id: payload.systemId }, data });
  } catch (err) {
    logger.warn({ err, proposalId: id }, 'chat.apply: update system failed');
    return { ok: false, formError: 'Could not update the system.' };
  }

  // UPDATE_SYSTEM fires the rename cascade ONLY. System is in neither
  // SEARCH_KINDS nor EmbeddingEntityType — it is not itself indexed or
  // embedded, only its name flows into child entities' embeds.
  await enqueueSystemRenameCascade(payload.systemId);

  await prisma.chatProposal.update({
    where: { id },
    data: { status: 'ACCEPTED', appliedEntityId: payload.systemId, appliedAt: new Date() },
  });

  revalidatePath('/systems');
  revalidatePath(`/systems/${payload.systemId}`);
  revalidatePath('/ask');

  return { ok: true, data: { id: payload.systemId } };
}

async function applyCreateServiceRecord(
  id: string,
  payload: Extract<ProposalPayload, { kind: 'CREATE_SERVICE_RECORD' }>,
): Promise<ActionResult<{ id: string }>> {
  const performedOn = parseCalendarDate(payload.performedOn.value);
  // Already validated against the union at propose time (validateProposal's
  // checkDate) — a null here would mean the stored payload was tampered
  // with or corrupted, not a normal user path. Fail closed rather than
  // fall back to `new Date()`, which would violate the calendar-date rule.
  if (!performedOn) {
    logger.warn({ proposalId: id }, 'chat.apply: performedOn failed to parse');
    return { ok: false, formError: 'This proposal has an invalid date and cannot be applied.' };
  }

  let record: { id: string };
  try {
    record = await prisma.serviceRecord.create({
      data: {
        summary: payload.summary.value,
        performedOn,
        notes: payload.notes?.value ?? null,
        selfPerformed: payload.selfPerformed,
        targets: {
          create: payload.targets.map((t) => ({
            itemId: t.itemId ?? null,
            systemId: t.systemId ?? null,
          })),
        },
      },
      select: { id: true },
    });
  } catch (err) {
    logger.warn({ err, proposalId: id }, 'chat.apply: create service record failed');
    return {
      ok: false,
      formError: 'Could not create the service record — a target may have been deleted.',
    };
  }

  await enqueueSearchIndex('service', record.id, 'upsert');
  await enqueueEmbed('SERVICE_RECORD', record.id);

  await prisma.chatProposal.update({
    where: { id },
    data: { status: 'ACCEPTED', appliedEntityId: record.id, appliedAt: new Date() },
  });

  revalidatePath('/service');
  revalidatePath('/dashboard');
  for (const t of payload.targets) {
    if (t.itemId) revalidatePath(`/items/${t.itemId}`);
    if (t.systemId) revalidatePath(`/systems/${t.systemId}`);
  }
  revalidatePath('/ask');

  return { ok: true, data: { id: record.id } };
}

/**
 * Apply one PENDING proposal: re-validate freshness for update kinds, write
 * the row, fire that kind's side effects, and flip status to ACCEPTED.
 * Never throws — every failure mode (missing/stale target, unparseable
 * payload, Prisma constraint error) returns `formError` instead.
 */
export async function applyProposal(proposalId: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, formError: 'Unauthorized' };

  const parsedId = proposalIdSchema.safeParse(proposalId);
  if (!parsedId.success) return { ok: false, formError: 'Invalid proposal id' };
  const id = parsedId.data;

  const proposal = await loadOwnedProposal(id, session.user.id);
  if (!proposal) return { ok: false, formError: 'Proposal not found' };

  // Idempotency guard — an ACCEPTED proposal cannot apply twice, and a
  // REJECTED/STALE/ORPHANED/INVALID one cannot apply at all.
  if (proposal.status !== 'PENDING') {
    return {
      ok: false,
      formError: `This proposal is ${proposal.status.toLowerCase()} and cannot be applied.`,
    };
  }

  const payload = parseStoredPayload(proposal.payload);
  if (!payload) {
    await prisma.chatProposal.update({ where: { id }, data: { status: 'INVALID' } });
    return {
      ok: false,
      formError: 'This proposal predates a schema change and can no longer be applied.',
    };
  }

  switch (payload.kind) {
    case 'CREATE_NOTE':
      return applyCreateNote(id, payload);
    case 'UPDATE_NOTE':
      return applyUpdateNote(id, payload, proposal.baseUpdatedAt);
    case 'CREATE_ITEM':
      return applyCreateItem(id, payload);
    case 'UPDATE_ITEM':
      return applyUpdateItem(id, payload, proposal.baseUpdatedAt);
    case 'UPDATE_SYSTEM':
      return applyUpdateSystem(id, payload, proposal.baseUpdatedAt);
    case 'CREATE_SERVICE_RECORD':
      return applyCreateServiceRecord(id, payload);
  }
}

/**
 * Reject a proposal. PENDING or STALE only — an ACCEPTED proposal must never
 * be rejectable (that would mislabel a change that was actually applied),
 * and REJECTED/ORPHANED/INVALID are already terminal.
 */
export async function rejectProposal(proposalId: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, formError: 'Unauthorized' };

  const parsedId = proposalIdSchema.safeParse(proposalId);
  if (!parsedId.success) return { ok: false, formError: 'Invalid proposal id' };
  const id = parsedId.data;

  const proposal = await loadOwnedProposal(id, session.user.id);
  if (!proposal) return { ok: false, formError: 'Proposal not found' };

  if (proposal.status !== 'PENDING' && proposal.status !== 'STALE') {
    return {
      ok: false,
      formError: `This proposal is ${proposal.status.toLowerCase()} and cannot be rejected.`,
    };
  }

  await prisma.chatProposal.update({ where: { id }, data: { status: 'REJECTED' } });
  return { ok: true, data: { id } };
}

/**
 * The only way out of STALE. Re-reads the target, recomputes `baseUpdatedAt`
 * + `beforeSnapshot` from that single read (same discipline as
 * `captureBeforeState` at propose time), and sets status back to PENDING.
 * Deliberately does NOT auto-apply — the record changed underneath and the
 * user has not yet seen the new state. Returns the full refreshed proposal
 * so the card can re-render without a separate query.
 */
export async function refreshProposal(
  proposalId: unknown,
): Promise<ActionResult<{ proposal: ChatTurnProposal }>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, formError: 'Unauthorized' };

  const parsedId = proposalIdSchema.safeParse(proposalId);
  if (!parsedId.success) return { ok: false, formError: 'Invalid proposal id' };
  const id = parsedId.data;

  const proposal = await loadOwnedProposal(id, session.user.id);
  if (!proposal) return { ok: false, formError: 'Proposal not found' };

  if (proposal.status !== 'STALE') {
    return {
      ok: false,
      formError: `This proposal is ${proposal.status.toLowerCase()}, not stale.`,
    };
  }

  const payload = parseStoredPayload(proposal.payload);
  if (!payload) {
    await prisma.chatProposal.update({ where: { id }, data: { status: 'INVALID' } });
    return {
      ok: false,
      formError: 'This proposal predates a schema change and can no longer be applied.',
    };
  }

  const { baseUpdatedAt, beforeSnapshot } = await captureBeforeState(payload);
  if (baseUpdatedAt === null) {
    await prisma.chatProposal.update({ where: { id }, data: { status: 'ORPHANED' } });
    return { ok: false, formError: 'The record this refers to was deleted.' };
  }

  const updated = await prisma.chatProposal.update({
    where: { id },
    data: { status: 'PENDING', baseUpdatedAt, beforeSnapshot: beforeSnapshot ?? undefined },
  });

  return {
    ok: true,
    data: {
      proposal: {
        id: updated.id,
        kind: updated.kind,
        targetType: updated.targetType,
        targetId: updated.targetId,
        payload: updated.payload as unknown as ProposalPayload,
        status: updated.status,
        baseUpdatedAt: updated.baseUpdatedAt,
        beforeSnapshot: updated.beforeSnapshot,
      },
    },
  };
}
