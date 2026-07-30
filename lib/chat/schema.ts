import { z } from 'zod';

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
 * Per-kind spec fields — bulb base, wattage, colour temperature; filter
 * dimensions; battery chemistry. This field is the reason the part arms exist:
 * without it the model dumps those specs into `notes` as prose, which is the
 * same shoehorn-into-the-nearest-construct bug one construct to the left, and
 * every AI-captured part lands with empty spec fields the user has to retype.
 *
 * Typed loosely HERE **on purpose**. The applicable spec schema is chosen by
 * the sibling `partKind` via `partKindSchemaFor`, and a field-level Zod schema
 * cannot see a sibling. `validateProposal` runs the real per-kind check — this
 * is NOT unvalidated, it is validated one layer up.
 */
const pMetadata = provenanced(z.record(z.string(), z.unknown())).optional();

/**
 * A part's parent link: an Item, a System, or **neither**. Unparented is the
 * legal standalone "generic bulbs" case, so unlike `CREATE_SERVICE_RECORD`
 * (whose `targets` array is `.min(1)`) there is no lower bound — only the
 * mutual exclusion.
 */
const exactlyOneParentOrNone = (value: { itemId?: string; systemId?: string }) =>
  !(value.itemId && value.systemId);

export const proposalPayloadSchema = z.discriminatedUnion('kind', [
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
  z
    .object({
      kind: z.literal('CREATE_PART'),
      name: pString,
      // NOT `kind` — `proposalPayloadSchema` discriminates on `kind`, and
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
      metadata: pMetadata,
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
    metadata: pMetadata,
    // No parent link here on purpose: re-parenting a part is a PartLink edit,
    // not a field update, and this pipeline has no arm for it.
  }),
]);

export type ProposalPayload = z.infer<typeof proposalPayloadSchema>;

/**
 * Parse a payload read back from the DB. Returns null rather than throwing when
 * the stored shape no longer matches the union (i.e. the payload predates a
 * schema change) — the caller marks the proposal INVALID.
 */
export function parseStoredPayload(raw: unknown): ProposalPayload | null {
  const parsed = proposalPayloadSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** What the model returns for one turn. */
export const chatTurnOutputSchema = z.object({
  reply: z.string(),
  proposals: z.array(proposalPayloadSchema).default([]),
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
