import type { PartKind } from '@prisma/client';

import { prisma } from '@/lib/db';
import { partKindSchemaFor } from '@/lib/parts/kinds';
import { parseCalendarDate } from './dates';
import { type ProposalPayload, stripNullish } from './schema';

// The model is handed a snapshot of every ID it may reference and MUST NOT mint
// one. Same discipline as validateCandidateIds in lib/incoming-email/ai-classify.
// A proposal referencing an unknown ID is dropped, never written.

export type Snapshot = {
  itemIds: Set<string>;
  systemIds: Set<string>;
  categoryIds: Set<string>;
  noteIds: Set<string>;
  partIds: Set<string>;
};

export type ValidationResult = { ok: true } | { ok: false; reason: string };

const bad = (reason: string): ValidationResult => ({ ok: false, reason });

/** Calendar dates arrive as YYYY-MM-DD and must parse to a real day. */
function checkDate(label: string, value: string | undefined): string | null {
  if (value === undefined) return null;
  return parseCalendarDate(value) ? null : `${label}: not a valid calendar date`;
}

/**
 * A part's spec is validated by the schema its `kind` selects — the same
 * `partKindSchemaFor` the parts form and `lib/parts/actions.ts` use, so a
 * chat-proposed BULB cannot land with a shape the parts UI then refuses to
 * re-save.
 *
 * These are non-strict `z.object`s, so an invented key (`bulbColour`) is
 * dropped silently and costs nothing. What this catches is a *wrong-typed*
 * value — `watts: "nine"`, `dimmable: "yes"` — which would otherwise reach
 * `prisma.part.update` and throw from inside apply, long after the user
 * accepted the proposal.
 */
function checkSpec(kind: PartKind, spec: Record<string, unknown> | undefined): ValidationResult {
  // Nulls are stripped, not rejected: `partSpecSchema` lets the model say
  // "not stated" with an explicit null, and the per-kind schemas take neither
  // null nor a key belonging to another kind. Absent is the same as null here.
  const result = partKindSchemaFor(kind).safeParse(stripNullish(spec ?? {}));
  if (result.success) return { ok: true };
  const first = result.error.issues[0];
  const path = first?.path.join('.');
  return bad(`spec: ${path ? `${path}: ` : ''}${first?.message ?? 'invalid for this kind'}`);
}

/**
 * Async because of ONE arm: `UPDATE_PART` may omit `partKind`, and the spec
 * schema cannot be chosen without knowing the part's stored kind. Same
 * resolution `updatePart` in `lib/parts/actions.ts` performs, for the same
 * reason.
 */
export async function validateProposal(
  p: ProposalPayload,
  snap: Snapshot,
): Promise<ValidationResult> {
  switch (p.kind) {
    case 'CREATE_NOTE':
      // itemId is optional — untargeted notes hold house-general knowledge and
      // are fully embedded and searchable.
      if (p.itemId && !snap.itemIds.has(p.itemId)) return bad('itemId not in snapshot');
      return { ok: true };

    case 'UPDATE_NOTE':
      if (!snap.noteIds.has(p.noteId)) return bad('noteId not in snapshot');
      return { ok: true };

    case 'CREATE_ITEM': {
      if (!snap.categoryIds.has(p.categoryId)) return bad('categoryId not in snapshot');
      const e = checkDate('purchaseDate', p.purchaseDate?.value);
      return e ? bad(e) : { ok: true };
    }

    case 'UPDATE_ITEM': {
      if (!snap.itemIds.has(p.itemId)) return bad('itemId not in snapshot');
      const e = checkDate('purchaseDate', p.purchaseDate?.value);
      return e ? bad(e) : { ok: true };
    }

    case 'UPDATE_SYSTEM': {
      if (!snap.systemIds.has(p.systemId)) return bad('systemId not in snapshot');
      const e = checkDate('installDate', p.installDate?.value);
      return e ? bad(e) : { ok: true };
    }

    case 'CREATE_SERVICE_RECORD': {
      const e = checkDate('performedOn', p.performedOn.value);
      if (e) return bad(e);
      for (const t of p.targets) {
        if (t.itemId && !snap.itemIds.has(t.itemId)) return bad('target itemId not in snapshot');
        if (t.systemId && !snap.systemIds.has(t.systemId))
          return bad('target systemId not in snapshot');
        // XOR, both directions. `service_record_targets` carries a hand-written
        // CHECK constraint (squashed migration.sql:747) that Prisma cannot
        // regenerate. Letting a both-set target through would throw a Prisma
        // constraint error from inside a server action, violating the
        // never-throw skeleton.
        if (!t.itemId && !t.systemId) return bad('target must name an item or a system');
        if (t.itemId && t.systemId) return bad('target must name exactly one of item or system');
      }
      return { ok: true };
    }

    case 'CREATE_PART': {
      // The parent is optional and mutually exclusive (the union's own
      // `.refine` rejects both-set). Neither-set is the legal standalone
      // "generic bulbs" case, so there is nothing to check when both are
      // absent.
      if (p.itemId && !snap.itemIds.has(p.itemId)) return bad('itemId not in snapshot');
      if (p.systemId && !snap.systemIds.has(p.systemId)) return bad('systemId not in snapshot');
      if (p.spec === undefined) return { ok: true };
      return checkSpec(p.partKind.value, p.spec.value);
    }

    case 'UPDATE_PART': {
      if (!snap.partIds.has(p.partId)) return bad('partId not in snapshot');
      if (p.spec === undefined) return { ok: true };
      let kind = p.partKind?.value;
      if (kind === undefined) {
        const existing = await prisma.part.findUnique({
          where: { id: p.partId },
          select: { kind: true },
        });
        if (!existing) return bad('partId no longer exists');
        kind = existing.kind;
      }
      return checkSpec(kind, p.spec.value);
    }
  }
}
