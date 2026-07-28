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
// ─── Incoming-email extraction ──────────────────────────────────────────────
//
// Extracted structured data from a vendor invoice / work ticket / estimate
// email body. All fields nullable — the model returns null when a field
// can't be confidently extracted, instead of guessing. The worker uses
// these to seed a new ServiceRecord when the user clicks
// "Create service record" from the inbox detail page. Not exported — only
// reused below to compose `incomingEmailClassifyExtractSchema`'s shape; the
// unified classify+extract schema is the public surface.
const incomingEmailExtractionSchema = z.object({
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

// Unified classify + extract result for inbound vendor emails. Classification
// fields (kind/vendor/target/confidence) join the extraction fields so a single
// AI call seeds everything. vendorId/targetItemId/targetSystemId are chosen from
// candidate lists passed in the prompt — the worker re-validates they exist
// (the model can hallucinate ids).
export const incomingEmailClassifyExtractSchema = z.object({
  kind: z.enum(['ESTIMATE', 'INVOICE', 'TICKET', 'UNKNOWN']),
  vendorId: z
    .string()
    .nullable()
    .describe('id of the matching vendor from the candidate list, or null if none clearly matches'),
  targetItemId: z
    .string()
    .nullable()
    .describe('id of the matching item from the candidate list, or null'),
  targetSystemId: z
    .string()
    .nullable()
    .describe(
      'id of the matching system from the candidate list, or null. Pick item OR system, not both.',
    ),
  confidence: z
    .enum(['low', 'medium', 'high'])
    .describe('overall confidence in the kind + vendor + target match'),
  summary: incomingEmailExtractionSchema.shape.summary,
  cost: incomingEmailExtractionSchema.shape.cost,
  performedOn: incomingEmailExtractionSchema.shape.performedOn,
  scope: incomingEmailExtractionSchema.shape.scope,
  rationale: incomingEmailExtractionSchema.shape.rationale,
});
export type IncomingEmailClassifyExtract = z.infer<typeof incomingEmailClassifyExtractSchema>;
