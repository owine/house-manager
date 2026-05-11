import { z } from 'zod';

export const createVendorSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  kind: z.string().max(100).optional(),
  phone: z.string().max(50).optional(),
  email: z.string().email().optional().or(z.literal('')),
  website: z.string().url().optional().or(z.literal('')),
  address: z.string().max(500).optional(),
  notes: z.string().max(20_000).optional(),
  tags: z.array(z.string().min(1).max(50)).default([]),
});

export const updateVendorSchema = createVendorSchema.partial().extend({
  id: z.string().min(1),
});

export type CreateVendorInput = z.infer<typeof createVendorSchema>;
type UpdateVendorInput = z.infer<typeof updateVendorSchema>;
