import type { ChatProposalKind, Prisma } from '@prisma/client';
import type { ChatTurnProposal } from '@/lib/chat/actions';
import { type ProposalPayload, parseStoredPayload } from '@/lib/chat/schema';

/** The shape `getChatSession` (lib/chat/queries.ts) returns for one proposal row. */
export type RawProposal = {
  id: string;
  kind: ChatProposalKind;
  targetType: string | null;
  targetId: string | null;
  payload: Prisma.JsonValue;
  status: string;
  baseUpdatedAt: Date | null;
  beforeSnapshot: Prisma.JsonValue | null;
};

/**
 * A placeholder payload for a kind whose stored JSON no longer parses. Only
 * ever rendered behind an INVALID status (ProposalCard skips the diff rows
 * in that case), so the values themselves are never shown — this exists
 * purely to satisfy `ChatTurnProposal.payload: ProposalPayload`.
 */
function stubPayload(kind: ChatProposalKind): ProposalPayload {
  const empty = { value: '', source: 'user' as const };
  switch (kind) {
    case 'CREATE_NOTE':
      return { kind, title: empty, body: empty, itemId: null };
    case 'UPDATE_NOTE':
      return { kind, noteId: '', body: empty };
    case 'CREATE_ITEM':
      return { kind, name: empty, categoryId: '' };
    case 'UPDATE_ITEM':
      return { kind, itemId: '' };
    case 'UPDATE_SYSTEM':
      return { kind, systemId: '' };
    case 'CREATE_SERVICE_RECORD':
      return { kind, summary: empty, performedOn: empty, selfPerformed: false, targets: [] };
    case 'CREATE_PART':
      return { kind, name: empty, partKind: { value: 'OTHER', source: 'user' } };
    case 'UPDATE_PART':
      return { kind, partId: '' };
  }
}

/**
 * Convert one DB-read proposal row into the shape `ProposalCard` renders.
 * `payload` is re-parsed here (it round-trips through `Json`, losing its
 * type) — a parse failure means the stored shape predates a schema change,
 * so the proposal renders as INVALID regardless of its stored status.
 */
export function toChatTurnProposal(raw: RawProposal): ChatTurnProposal {
  const parsed = parseStoredPayload(raw.payload);
  return {
    id: raw.id,
    kind: raw.kind,
    targetType: raw.targetType,
    targetId: raw.targetId,
    payload: parsed ?? stubPayload(raw.kind),
    status: parsed ? raw.status : 'INVALID',
    baseUpdatedAt: raw.baseUpdatedAt,
    beforeSnapshot: raw.beforeSnapshot,
  };
}
