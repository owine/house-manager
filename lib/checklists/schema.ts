import { z } from 'zod';

export const createChecklistSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(2000).optional(),
});

export const updateChecklistSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(2000).nullable().optional(),
  active: z.boolean().optional(),
});

export const checklistItemInputSchema = z.object({
  title: z.string().min(1).max(120),
  itemId: z.string().min(1).nullable().optional(),
});

export const addChecklistItemSchema = z.object({
  checklistId: z.string().min(1),
  ...checklistItemInputSchema.shape,
});

export const reorderChecklistItemsSchema = z.object({
  checklistId: z.string().min(1),
  orderedItemIds: z.array(z.string().min(1)).min(1),
});
