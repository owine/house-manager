import { parseCalendarDate } from './dates';
import type { ProposalPayload } from './schema';

// The model is handed a snapshot of every ID it may reference and MUST NOT mint
// one. Same discipline as validateCandidateIds in lib/incoming-email/ai-classify.
// A proposal referencing an unknown ID is dropped, never written.

export type Snapshot = {
  itemIds: Set<string>;
  systemIds: Set<string>;
  categoryIds: Set<string>;
  noteIds: Set<string>;
};

export type ValidationResult = { ok: true } | { ok: false; reason: string };

const bad = (reason: string): ValidationResult => ({ ok: false, reason });

/** Calendar dates arrive as YYYY-MM-DD and must parse to a real day. */
function checkDate(label: string, value: string | undefined): string | null {
  if (value === undefined) return null;
  return parseCalendarDate(value) ? null : `${label}: not a valid calendar date`;
}

export function validateProposal(p: ProposalPayload, snap: Snapshot): ValidationResult {
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
  }
}
