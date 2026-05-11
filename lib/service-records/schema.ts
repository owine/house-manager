import { z } from 'zod';
import { targetSchema } from '@/lib/targets/schema';

// Service records are the one event type that meaningfully exists without an
// item/system: vendor-only "the lawn got mowed" or "windows washed" records
// have no specific target. The shared `targetsArraySchema` requires .min(1)
// for warranties + reminders (which inherently target something), so service
// records use a looser local array + a cross-field refine that requires
// at least one of vendor / targets to be set.
const serviceRecordTargetsSchema = z.array(targetSchema);

const baseServiceRecordSchema = z.object({
  targets: serviceRecordTargetsSchema,
  vendorId: z.string().min(1).optional(),
  performedOn: z.coerce.date(),
  cost: z.coerce.number().nonnegative().optional(),
  summary: z.string().min(1, 'Summary is required').max(200),
  notes: z.string().max(20_000).optional(),
});

function requireVendorOrTargets(
  v: { vendorId?: string; targets?: { itemId?: string | null; systemId?: string | null }[] },
  ctx: z.RefinementCtx,
) {
  const hasVendor = Boolean(v.vendorId);
  const hasTargets = Array.isArray(v.targets) && v.targets.length > 0;
  if (!hasVendor && !hasTargets) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Pick a vendor or at least one item/system',
      path: ['targets'],
    });
  }
}

export const createServiceRecordSchema =
  baseServiceRecordSchema.superRefine(requireVendorOrTargets);

export const updateServiceRecordSchema = baseServiceRecordSchema
  .partial()
  .extend({ id: z.string().min(1) });

export type CreateServiceRecordInput = z.infer<typeof createServiceRecordSchema>;
