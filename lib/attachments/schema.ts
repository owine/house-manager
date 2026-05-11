import { z } from 'zod';

const PARENT_TYPES = ['item', 'warranty', 'serviceRecord', 'note'] as const;
export type ParentType = (typeof PARENT_TYPES)[number];

export const uploadAttachmentSchema = z.object({
  parentType: z.enum(PARENT_TYPES),
  parentId: z.string().min(1),
});

type UploadAttachmentInput = z.infer<typeof uploadAttachmentSchema>;

const httpUrl = z
  .string()
  .url()
  .refine((s) => /^https?:\/\//i.test(s), 'URL must use http:// or https://');

export const addAttachmentLinkSchema = z.object({
  parentType: z.enum(PARENT_TYPES),
  parentId: z.string().min(1),
  externalUrl: httpUrl,
  displayLabel: z.string().max(200).optional().or(z.literal('')),
  externalProvider: z.string().max(50).optional(),
  externalProviderId: z.string().max(200).optional(),
});

type AddAttachmentLinkInput = z.infer<typeof addAttachmentLinkSchema>;
