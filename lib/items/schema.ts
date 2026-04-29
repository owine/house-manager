import { z } from 'zod';

export const createItemSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  categorySlug: z.string().min(1, 'Category is required'),
  location: z.string().max(200).optional(),
  manufacturer: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  serialNumber: z.string().max(200).optional(),
  purchaseDate: z.coerce.date().optional(),
  purchasePrice: z.coerce.number().nonnegative().optional(),
  metadata: z.unknown().default({}),
  notes: z.string().max(20_000).optional(),
});

export const updateItemSchema = createItemSchema.partial().extend({
  id: z.string().min(1),
});

export type CreateItemInput = z.infer<typeof createItemSchema>;
export type UpdateItemInput = z.infer<typeof updateItemSchema>;
