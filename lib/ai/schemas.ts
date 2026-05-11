import { z } from 'zod';

export const recurrenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('interval'), days: z.number().int().min(1).max(3650) }),
  z.object({ kind: z.literal('monthly'), dayOfMonth: z.number().int().min(1).max(28) }),
  z.object({
    kind: z.literal('yearly'),
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(28),
  }),
]);
export type ProposedRecurrence = z.infer<typeof recurrenceSchema>;

export const proposedReminderSchema = z.object({
  title: z.string().min(3).max(120),
  description: z.string().max(500).optional(),
  recurrence: recurrenceSchema,
  leadTimeDays: z.number().int().min(0).max(60).default(3),
  rationale: z.string().max(200).describe('One sentence explaining why this reminder is suggested'),
});
export type ProposedReminder = z.infer<typeof proposedReminderSchema>;

export const proposeRemindersResponseSchema = z.object({
  proposals: z.array(proposedReminderSchema).max(10),
});
type ProposeRemindersResponse = z.infer<typeof proposeRemindersResponseSchema>;

export const proposedChecklistItemSchema = z.object({
  title: z.string().min(3).max(120),
  itemId: z.string().nullable().describe('ID of household item this row is about, or null'),
  rationale: z.string().max(200),
});
export type ProposedChecklistItem = z.infer<typeof proposedChecklistItemSchema>;

export const proposeChecklistResponseSchema = z.object({
  name: z.string().min(3).max(80),
  description: z.string().max(500).optional(),
  items: z.array(proposedChecklistItemSchema).min(1).max(20),
});
type ProposeChecklistResponse = z.infer<typeof proposeChecklistResponseSchema>;

// ─── Incoming-email extraction ──────────────────────────────────────────────
//
// Extracted structured data from a vendor invoice / work ticket / estimate
// email body. All fields nullable — the model returns null when a field
// can't be confidently extracted, instead of guessing. The worker uses
// these to seed a new ServiceRecord when the user clicks
// "Create service record" from the inbox detail page.
export const incomingEmailExtractionSchema = z.object({
  summary: z
    .string()
    .max(120)
    .nullable()
    .describe(
      'Short title for this service (e.g. "Spring HVAC tune-up", "Replace bathroom faucet"). Punchier than the email subject. Title-case, no trailing period, max ~10 words. Null only if the body has nothing to summarize.',
    ),
  cost: z
    .number()
    .nonnegative()
    .nullable()
    .describe(
      'Total amount due in dollars (USD). Use the line-item / invoice grand total, not subtotals or tax-exclusive figures. Null if not stated.',
    ),
  performedOn: z
    .string()
    .nullable()
    .describe(
      'Date the work was performed, ISO format (YYYY-MM-DD). Look for explicit "service date", "visit date", "performed on" cues. NOT the email send date or invoice date. Null if not stated.',
    ),
  scope: z
    .string()
    .max(2000)
    .nullable()
    .describe(
      'Detailed description of the work performed and findings, formatted as markdown. Use **bold** for key components, bullet lists for multiple line items, and short paragraphs for narrative sections. Goes into the service-record `notes` field which renders markdown. Null only if the body has zero useful content.',
    ),
  rationale: z
    .string()
    .max(1000)
    .describe('One or two sentences explaining how confident the extraction is and any caveats.'),
});
export type IncomingEmailExtraction = z.infer<typeof incomingEmailExtractionSchema>;

// ──────────────────────────────────────────────────────────────────────────────
// Plan 4c — Ask / RAG response schema.
// The model is constrained to return { answer, citations } where each citation
// is one of the EmbeddingEntityType variants plus the parent entity's ID so
// the UI can deep-link to the source. Citation label is the human-readable
// title (e.g. "Annual spring tune-up — 2026-04-12") rendered on the chip.
// ──────────────────────────────────────────────────────────────────────────────
const askCitationSchema = z.object({
  entityType: z.enum([
    'ITEM',
    'NOTE',
    'SERVICE_RECORD',
    'CHECKLIST_ITEM',
    'WARRANTY',
    'ATTACHMENT',
  ]),
  entityId: z.string().min(1).max(64),
  label: z.string().max(200),
});
export type AskCitation = z.infer<typeof askCitationSchema>;

export const askAnswerSchema = z.object({
  answer: z
    .string()
    .max(4000)
    .describe(
      'The answer to the user question, in markdown. Cite every factual claim by referencing the supporting chunks via their entityType+entityId tags. If the provided context does not contain the answer, say so explicitly — do not invent facts.',
    ),
  citations: z
    .array(askCitationSchema)
    .max(8)
    .describe(
      'Up to 8 source citations from the retrieved chunks, ordered by relevance. Empty array is allowed when the question is unanswerable from context.',
    ),
});
export type AskAnswer = z.infer<typeof askAnswerSchema>;

export const askQuestionInputSchema = z.object({
  question: z.string().trim().min(3, 'Question is too short').max(500, 'Question is too long'),
  entityTypes: z
    .array(z.enum(['ITEM', 'NOTE', 'SERVICE_RECORD', 'CHECKLIST_ITEM', 'WARRANTY', 'ATTACHMENT']))
    .optional(),
});
type AskQuestionInput = z.infer<typeof askQuestionInputSchema>;
