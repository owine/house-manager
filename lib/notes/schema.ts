import { z } from 'zod';

export const createNoteSchema = z.object({
  title: z.string().min(1, 'Title is required').max(200),
  body: z.string().min(1, 'Body is required').max(20_000),
  itemId: z.string().min(1).optional(),
  tags: z.array(z.string()).default([]),
});

export const updateNoteSchema = createNoteSchema.partial().extend({
  id: z.string().min(1),
});

export type CreateNoteInput = z.infer<typeof createNoteSchema>;
export type UpdateNoteInput = z.infer<typeof updateNoteSchema>;
