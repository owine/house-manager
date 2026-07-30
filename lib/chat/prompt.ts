import type { PartKind } from '@prisma/client';
import { z } from 'zod';

import { partKindConfigs } from '@/lib/parts/kinds';

/**
 * One kind's spec fields, rendered for the prompt.
 *
 * Derived from `partKindConfigs` rather than hand-written: a second copy of
 * this list drifts the moment a field is added, and the failure is invisible —
 * the model simply stops proposing the field it was never told about.
 *
 * Every field in those schemas is `.optional()`, so the declared type is
 * always a `ZodOptional` wrapper that has to come off before the inner type is
 * legible. Enum members are spelled out because they are the fields the model
 * otherwise invents plausible-but-wrong values for ("E27" for a US socket,
 * "warm-white" for a technology).
 */
function specFieldsFor(schema: z.ZodTypeAny): string | null {
  // `OTHER` is `freeformMetadataSchema` — a record, not an object, so it has
  // no field list to enumerate.
  if (!(schema instanceof z.ZodObject)) return null;

  return Object.entries(schema.shape as Record<string, z.ZodTypeAny>)
    .map(([name, field]) => {
      let inner: z.ZodTypeAny = field;
      while (inner instanceof z.ZodOptional) inner = inner.unwrap() as z.ZodTypeAny;
      if (inner instanceof z.ZodEnum) {
        return `${name} (${(inner.options as string[]).join('|')})`;
      }
      return name;
    })
    .join(', ');
}

/**
 * The per-kind spec-field table the model is shown, generated from the schemas.
 * Shared by the main chat prompt and the parts-extraction prompt in
 * `lib/chat/parts-extract.ts` — one table, one source, no second copy to drift.
 */
export function buildPartSpecTable(): string {
  return (Object.keys(partKindConfigs) as PartKind[])
    .map((kind) => {
      const fields = specFieldsFor(partKindConfigs[kind]);
      return `   ${kind}: ${fields ?? 'any keys — freeform'}`;
    })
    .join('\n');
}

export const CHAT_SYSTEM_PROMPT = `You are the assistant inside a self-hosted home information manager.

The user will either ASK you something about their house, or TELL you something
new. Decide which from the turn itself — a single turn may do both.

When the user ASKS: answer from the retrieved context. If the context does not
support an answer, say so. Do not guess.

When the user TELLS you something: propose structured changes to their records.

RULES FOR PROPOSALS

1. IDs. You are given a snapshot of every item, system, category, note and part
   you may reference. Only ever use an id from that snapshot. NEVER invent an id, and
   never propose a change to something that is not listed. If the user refers to
   something you cannot find, say so and propose nothing for it.

2. Dates. Always emit calendar dates as YYYY-MM-DD strings. Never emit a
   timestamp. Today's date at the house is given in the snapshot — resolve
   relative expressions ("Tuesday", "last week") against it.

3. Notes. Prefer a note for knowledge that is not an event. Keep every note
   SHORT and scoped to ONE topic, using "##" headed sections. Do NOT produce one
   large markdown table — long tables are split during indexing and the trailing
   pieces lose their header row, making them unretrievable. If you have more
   than one topic, propose several small notes instead of one big one.
   Leave itemId null when the knowledge is house-general rather than about one
   specific item.

4. Provenance. You may enrich what the user typed using your own knowledge — for
   example decoding a model number into its specifications. Mark every value you
   inferred with source "inferred". Mark everything the user actually said with
   source "user". Never present an inference as something the user told you.

5. Scope. You may create notes, items and service records, and update notes,
   items and systems. You may NOT delete, archive or unlink anything.

6. Consumables are NOT yours. A consumable or replaceable component the user
   re-buys — a bulb, an air or water filter, a battery, a belt, a fuse,
   softener salt — is a PART, and a separate pass over this same turn records
   it. So:
     - Do NOT create an item for one. A proposal of yours and a part proposal
       for the same bulbs is a duplicate the user has to untangle.
     - Do NOT copy its specifications (base, wattage, colour temperature, MERV
       rating, size) into a note or into an item's notes. They are captured as
       structured fields elsewhere.
   An ITEM is the thing that consumes the part — the light fixture, the
   furnace — and a new one is still yours to propose. Bulbs are a part; the
   fixture they go in is an item. When the user describes something by its
   SPECIFICATION rather than by purchase or serial number, it is a part and you
   should leave it alone.

7. Privacy. When answering from retrieved context, never echo serial numbers,
   exact addresses, or other PII verbatim in your reply, even though the
   underlying records may contain them. Refer to the record by name instead.

Be brief in your reply. The proposals carry the detail.`;

export type SnapshotInput = {
  anchorDay: string;
  items: Array<{ id: string; name: string; categoryName: string; location: string | null }>;
  systems: Array<{ id: string; name: string; location: string | null }>;
  categories: Array<{ id: string; name: string }>;
  notes: Array<{ id: string; title: string }>;
  // Manufacturer/model travel alongside name and kind so the model can tell a
  // BR30 bulb from a MERV 11 filter when the user says "order more of those".
  parts: Array<{
    id: string;
    name: string;
    kind: PartKind;
    manufacturer: string | null;
    model: string | null;
  }>;
};

/**
 * The snapshot the model resolves references against. Every id it may legally
 * emit appears here; `validateProposal` re-checks each one server-side.
 */
export function buildSnapshotBlock(s: SnapshotInput): string {
  const lines = [
    `Today at the house: ${s.anchorDay}`,
    '',
    'CATEGORIES (id | name)',
    ...s.categories.map((c) => `${c.id} | ${c.name}`),
    '',
    'SYSTEMS (id | name | location)',
    ...s.systems.map((x) => `${x.id} | ${x.name} | ${x.location ?? '-'}`),
    '',
    'ITEMS (id | name | category | location)',
    ...s.items.map((i) => `${i.id} | ${i.name} | ${i.categoryName} | ${i.location ?? '-'}`),
    '',
    'NOTES (id | title)',
    ...s.notes.map((n) => `${n.id} | ${n.title}`),
    '',
    'PARTS (id | name | kind | manufacturer | model)',
    ...s.parts.map(
      (p) => `${p.id} | ${p.name} | ${p.kind} | ${p.manufacturer ?? '-'} | ${p.model ?? '-'}`,
    ),
  ];
  return lines.join('\n');
}
