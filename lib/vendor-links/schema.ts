import { z } from 'zod';

export const vendorRoleEnum = z.enum([
  'PURCHASE',
  'INSTALLER',
  'SERVICE',
  'WARRANTY_PROVIDER',
  'MANUFACTURER',
  'OTHER',
]);

export const vendorLinkSchema = z
  .object({
    vendorId: z.string().optional().nullable(),
    freeformName: z.string().min(1).max(120).optional().nullable(),
    role: vendorRoleEnum,
    notes: z.string().max(20_000).optional().nullable(),
  })
  .refine((v) => Boolean(v.vendorId) !== Boolean(v.freeformName), {
    message: 'exactly one of vendorId / freeformName must be set',
  });

export type VendorLinkInput = z.infer<typeof vendorLinkSchema>;
