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
  selfPerformed: z.boolean().default(false),
  performedOn: z.coerce.date(),
  cost: z.coerce.number().nonnegative().optional(),
  summary: z.string().min(1, 'Summary is required').max(200),
  notes: z.string().max(20_000).optional(),
});

function requireAnchor(
  v: {
    vendorId?: string;
    selfPerformed?: boolean;
    targets?: { itemId?: string | null; systemId?: string | null }[];
  },
  ctx: z.RefinementCtx,
) {
  const hasVendor = Boolean(v.vendorId);
  const hasTargets = Array.isArray(v.targets) && v.targets.length > 0;
  const isSelf = v.selfPerformed === true;
  if (!hasVendor && !hasTargets && !isSelf) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Pick a vendor, a self-performed marker, or at least one item/system',
      path: ['targets'],
    });
  }
  if (isSelf && hasVendor) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A self-performed record can't also have a vendor",
      path: ['vendorId'],
    });
  }
}

export const createServiceRecordSchema = baseServiceRecordSchema.superRefine(requireAnchor);

export const updateServiceRecordSchema = baseServiceRecordSchema
  .partial()
  .extend({ id: z.string().min(1) })
  .superRefine((v, ctx) => {
    if (v.selfPerformed === true && v.vendorId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A self-performed record can't also have a vendor",
        path: ['vendorId'],
      });
    }
  });

export type CreateServiceRecordInput = z.infer<typeof createServiceRecordSchema>;
