import { z } from 'zod';

import { partKindConfigs } from '@/lib/parts/kinds';
import { PART_KINDS } from '@/lib/parts/schema';

// The ENTIRE model-facing schema for conversational capture lives here — the
// turn envelope and the proposal payload union both.
//
// Deliberate deviation from precedent: lib/ai/schemas.ts holds model-facing zod
// for Ask and the email classifier, but this union is also the persistence
// contract read back by the apply action, so it belongs with the feature.
// Keeping the envelope here too avoids inverting the dependency direction —
// lib/ask/actions.ts imports FROM lib/ai/schemas.ts and never the reverse.

/**
 * Server-enforced ceiling on a proposed note body.
 *
 * Chunking happens after canonicalization at ~500 tokens (~2000 chars), and
 * `canonicalizeNote` prepends the title to the body — so chunk 1+ of a long
 * note is bare text with no title and retrieves badly. Markdown tables fare
 * worse: `chunkText` splits on newlines, so trailing chunks are bare rows with
 * no header. Keeping bodies short also keeps inferred-value markers in the same
 * chunk as the facts they annotate.
 *
 * Note this does NOT fix the same pathology for hand-written notes, which
 * `createNoteSchema` allows up to 20,000 chars. It only stops this path adding
 * more.
 */
export const NOTE_BODY_MAX = 1800;

/** A field value plus where it came from. `inferred` renders with a badge. */
const provenanced = <T extends z.ZodTypeAny>(inner: T) =>
  z.object({ value: inner, source: z.enum(['user', 'inferred']) });

const pString = provenanced(z.string().min(1));
const pOptionalString = provenanced(z.string()).optional();
/** Calendar dates cross the wire as YYYY-MM-DD strings, never timestamps. */
const pCalendarDate = provenanced(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional();

const noteBody = provenanced(z.string().min(1).max(NOTE_BODY_MAX));

/**
 * `Part.typicalCost` is `Decimal(10, 2)`, so it crosses the wire as a decimal
 * string for the same reason calendar dates cross as `YYYY-MM-DD` — a JS number
 * is the wrong carrier for a fixed-scale column.
 *
 * The regex is the whole guard. Dates get a `checkDate` in `validateProposal`;
 * without the equivalent here a model emitting `"about $4.50"` or `"4.505"`
 * would pass the union, pass validation, and only blow up at
 * `prisma.part.create` — long after the user accepted the proposal.
 */
const pDecimalAmount = provenanced(z.string().regex(/^\d{1,8}(\.\d{1,2})?$/)).optional();

/**
 * The flat union of every part kind's spec fields, generated from
 * `partKindConfigs` so the two cannot drift.
 *
 * **Flat and typed, not `z.record(z.string(), z.unknown())`** — that shape was
 * tried first and the model returned `{}` on every single run, even with a
 * worked example in the prompt: `unknown` gives a decoder no productions to
 * emit, and even unconstrained it is a typed shape that makes the model
 * actually fill fields in. This one field is the reason the part arms exist at
 * all; without it the specs land in `notes` as prose, which is the same
 * shoehorn-into-the-nearest-construct bug one construct to the left.
 *
 * Fields are `.optional().nullable()`: the user knows a bulb's base and nothing
 * else, and an unconstrained model emits `null` for "not stated" about as often
 * as it omits the key. `stripNullish` drops the nulls before the payload is
 * stored, so `partKindSchemaFor` (which rejects null) never sees one.
 *
 * Kinds are still validated per-kind, one layer up: `validateProposal` runs
 * `partKindSchemaFor(partKind)`, which is what rejects `merv` on a BULB. A
 * field-level Zod schema cannot see its sibling `partKind`, so it cannot do
 * that itself.
 */
function buildPartSpecShape(): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const schema of Object.values(partKindConfigs)) {
    // `OTHER` is `freeformMetadataSchema` — a ZodRecord, with no field list to
    // union in. Its specs travel as whatever the other kinds' fields allow.
    if (!(schema instanceof z.ZodObject)) continue;
    for (const [name, field] of Object.entries(schema.shape as Record<string, z.ZodTypeAny>)) {
      // First definition wins. The only names shared across kinds today are
      // `voltage` (bulb/battery/fuse) and `ratedMonths` (air/water filter), and
      // each is declared identically — but taking the first keeps the result
      // deterministic if that ever stops being true.
      if (shape[name]) continue;
      let inner: z.ZodTypeAny = field;
      while (inner instanceof z.ZodOptional) inner = inner.unwrap() as z.ZodTypeAny;
      shape[name] = inner.optional().nullable();
    }
  }
  return shape;
}

const partSpecSchema = z.object(buildPartSpecShape());

const pSpec = provenanced(partSpecSchema).optional();

/**
 * Drop `null`/`undefined` entries from a proposed spec.
 *
 * `partSpecSchema` accepts nulls because the model emits them for "not stated";
 * `partKindSchemaFor`'s per-kind schemas do not accept them at all. Everything
 * downstream of extraction — validation, the diff rows, the `Part.metadata`
 * write — wants the null-free shape.
 */
export function stripNullish(spec: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(spec).filter(([, v]) => v !== null && v !== undefined));
}

/**
 * A part's parent link: an Item, a System, or **neither**. Unparented is the
 * legal standalone "generic bulbs" case, so unlike `CREATE_SERVICE_RECORD`
 * (whose `targets` array is `.min(1)`) there is no lower bound — only the
 * mutual exclusion.
 */
const exactlyOneParentOrNone = (value: { itemId?: string; systemId?: string }) =>
  !(value.itemId && value.systemId);

/**
 * The six arms the model may emit from the MAIN chat call — the union handed to
 * `zodOutputFormat`, i.e. compiled into a constrained-decoding grammar.
 *
 * **Adding an arm here is not free.** Three ceilings apply at the API boundary
 * and nowhere else — no local gate can see them, and blowing one 400s every
 * chat turn:
 *
 *   1. ≤24 **optional** parameters across the whole compiled schema. These six
 *      arms spend 19.
 *   2. A cap on the compiled **grammar size**, which these six are already near.
 *      `$ref` does not help: the compiler expands refs, so a shared sub-object
 *      is charged once per use site.
 *   3. ~49 **union-typed** parameters — and `nullable` IS a union, so the
 *      obvious escape from (1) spends (3).
 *
 * `lib/chat/schema-budget.test.ts` guards (1) and (3). (2) is only observable
 * against the live API.
 *
 * This is why the part arms live in `partProposalPayloadSchema` below and are
 * extracted by a second, UNCONSTRAINED call (`lib/chat/parts-extract.ts`), to
 * which none of the three limits apply.
 */
const GRAMMAR_ARMS = [
  z.object({
    kind: z.literal('CREATE_NOTE'),
    title: pString,
    body: noteBody,
    itemId: z.string().nullable().default(null),
  }),
  z.object({
    kind: z.literal('UPDATE_NOTE'),
    noteId: z.string().min(1),
    title: pString.optional(),
    // `body` is required, not optional like `title` — intentional. UPDATE_NOTE
    // replaces the body wholesale; there is no title-only proposal shape.
    body: noteBody,
  }),
  z.object({
    kind: z.literal('CREATE_ITEM'),
    name: pString,
    // Non-null on the Item model. The model picks from the snapshot and the
    // server validates the pick — never defaulted.
    categoryId: z.string().min(1),
    manufacturer: pOptionalString,
    model: pOptionalString,
    serialNumber: pOptionalString,
    location: pOptionalString,
    purchaseDate: pCalendarDate,
  }),
  z.object({
    kind: z.literal('UPDATE_ITEM'),
    itemId: z.string().min(1),
    name: pString.optional(),
    manufacturer: pOptionalString,
    model: pOptionalString,
    serialNumber: pOptionalString,
    location: pOptionalString,
    notes: pOptionalString,
    purchaseDate: pCalendarDate,
  }),
  z.object({
    kind: z.literal('UPDATE_SYSTEM'),
    systemId: z.string().min(1),
    name: pString.optional(),
    kindLabel: pOptionalString,
    location: pOptionalString,
    notes: pOptionalString,
    installDate: pCalendarDate,
  }),
  z.object({
    kind: z.literal('CREATE_SERVICE_RECORD'),
    summary: pString,
    performedOn: provenanced(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
    notes: pOptionalString,
    selfPerformed: z.boolean().default(false),
    targets: z
      .array(z.object({ itemId: z.string().nullable(), systemId: z.string().nullable() }))
      .min(1),
  }),
] as const;

/**
 * The part arms. Deliberately NOT in `GRAMMAR_ARMS`: they are produced by the
 * separate unconstrained extraction call, and adding a seventh and eighth arm
 * to the grammar breaks every chat turn (see the comment above).
 *
 * They are still full members of `storedProposalPayloadSchema` — storage,
 * validation, `captureBeforeState`, apply and the diff card all read part
 * payloads back through it.
 */
const PART_ARMS = [
  z
    .object({
      kind: z.literal('CREATE_PART'),
      name: pString,
      // NOT `kind` — the payload union discriminates on `kind`, and
      // `Part.kind` means something else entirely. `UPDATE_SYSTEM` hit the same
      // collision and renamed `System.kind` to `kindLabel`; this follows suit.
      //
      // Typed as the enum, not a string: a loose string lets the model emit
      // `'bulb'`, which only throws at `prisma.part.create` after the user has
      // already accepted.
      partKind: provenanced(z.enum(PART_KINDS)),
      manufacturer: pOptionalString,
      model: pOptionalString,
      location: pOptionalString,
      notes: pOptionalString,
      typicalCost: pDecimalAmount,
      spec: pSpec,
      itemId: z.string().min(1).optional(),
      systemId: z.string().min(1).optional(),
    })
    .refine(exactlyOneParentOrNone, {
      message: 'A part links to an item or a system, not both',
      path: ['systemId'],
    }),
  z.object({
    kind: z.literal('UPDATE_PART'),
    partId: z.string().min(1),
    name: pString.optional(),
    partKind: provenanced(z.enum(PART_KINDS)).optional(),
    manufacturer: pOptionalString,
    model: pOptionalString,
    location: pOptionalString,
    notes: pOptionalString,
    typicalCost: pDecimalAmount,
    spec: pSpec,
    // No parent link here on purpose: re-parenting a part is a PartLink edit,
    // not a field update, and this pipeline has no arm for it.
  }),
] as const;

/**
 * What the parts-extraction call may return. Same arms the storage union
 * carries, so the extractor and the persistence contract cannot drift.
 */
export const partProposalPayloadSchema = z.discriminatedUnion('kind', PART_ARMS);
export type PartProposalPayload = z.infer<typeof partProposalPayloadSchema>;

/**
 * **All eight arms** — the persistence contract. Everything downstream of the
 * model reads payloads back through this: `parseStoredPayload`,
 * `captureBeforeState`, `applyProposal`, `buildRows`, `stubPayload`.
 *
 * A new proposal kind goes HERE. Whether it also belongs in `GRAMMAR_ARMS`
 * depends on whether the main constrained call can still afford it — read that
 * comment before assuming it can.
 */
export const storedProposalPayloadSchema = z.discriminatedUnion('kind', [
  ...GRAMMAR_ARMS,
  ...PART_ARMS,
]);

export type ProposalPayload = z.infer<typeof storedProposalPayloadSchema>;

/**
 * Parse a payload read back from the DB. Returns null rather than throwing when
 * the stored shape no longer matches the union (i.e. the payload predates a
 * schema change) — the caller marks the proposal INVALID.
 */
export function parseStoredPayload(raw: unknown): ProposalPayload | null {
  const parsed = storedProposalPayloadSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * What the MAIN model call returns for one turn — and the only schema in this
 * file that reaches `zodOutputFormat`. Six arms, never eight: see
 * `GRAMMAR_ARMS`.
 */
export const chatTurnOutputSchema = z.object({
  reply: z.string(),
  proposals: z.array(z.discriminatedUnion('kind', GRAMMAR_ARMS)).default([]),
});

const chatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(8000),
});

/**
 * Input for one chat turn. The last user message allows 8000 chars — Ask's
 * 500-char cap is incompatible with a feature about dumping unstructured
 * thoughts.
 */
export const chatTurnInputSchema = z.object({
  sessionId: z.string().optional(),
  messages: z
    .array(chatMessageSchema)
    .min(1)
    .max(20)
    .refine(
      (msgs) => {
        const last = msgs[msgs.length - 1];
        if (last?.role !== 'user') return false;
        // No upper bound here: chatMessageSchema.content already caps at
        // .max(8000), so trimmed.length can never exceed that — an explicit
        // `<= 8000` check would be unreachable dead code.
        return last.content.trim().length >= 3;
      },
      {
        message: 'Last message must be from the user and at least 3 characters',
        path: ['messages'],
      },
    ),
});

export type ChatTurnInput = z.input<typeof chatTurnInputSchema>;
