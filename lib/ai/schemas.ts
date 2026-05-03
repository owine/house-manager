import { z } from 'zod';

export const recurrenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('interval'), days: z.number().int().min(1).max(3650) }),
  z.object({ kind: z.literal('monthly'), dayOfMonth: z.number().int().min(1).max(31) }),
  z.object({
    kind: z.literal('yearly'),
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(31),
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
export type ProposeRemindersResponse = z.infer<typeof proposeRemindersResponseSchema>;

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
export type ProposeChecklistResponse = z.infer<typeof proposeChecklistResponseSchema>;
