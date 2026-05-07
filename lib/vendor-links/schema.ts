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
    serviceContract: z.boolean().default(false),
    // Normalize to UTC midnight so callers can't accidentally persist non-midnight
    // times that the underlying @db.Date column would silently truncate.
    contractEndsOn: z.coerce
      .date()
      .transform((d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())))
      .optional()
      .nullable(),
  })
  .refine((v) => Boolean(v.vendorId) !== Boolean(v.freeformName), {
    message: 'exactly one of vendorId / freeformName must be set',
  })
  .refine((v) => !v.contractEndsOn || v.serviceContract, {
    message: 'contractEndsOn requires serviceContract = true',
    path: ['contractEndsOn'],
  });

export type VendorLinkInput = z.infer<typeof vendorLinkSchema>;

/**
 * Canonical "blank" link draft — the only place new fields should be
 * defaulted. Sections and tests should use this instead of inlining a
 * literal so a future column add doesn't drift across call sites.
 */
export function emptyVendorLinkInput(): VendorLinkInput {
  return {
    vendorId: null,
    freeformName: null,
    role: 'INSTALLER',
    notes: null,
    serviceContract: false,
    contractEndsOn: null,
  };
}
