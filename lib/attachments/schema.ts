import { z } from 'zod';

export const PARENT_TYPES = ['item', 'warranty', 'serviceRecord', 'note'] as const;
export type ParentType = (typeof PARENT_TYPES)[number];

export const uploadAttachmentSchema = z.object({
  parentType: z.enum(PARENT_TYPES),
  parentId: z.string().min(1),
});

export type UploadAttachmentInput = z.infer<typeof uploadAttachmentSchema>;
