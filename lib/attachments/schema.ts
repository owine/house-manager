import { z } from 'zod';

import { httpUrlSchema } from '@/lib/http-url';

const PARENT_TYPES = ['item', 'warranty', 'serviceRecord', 'note', 'part'] as const;
export type ParentType = (typeof PARENT_TYPES)[number];

export const uploadAttachmentSchema = z.object({
  parentType: z.enum(PARENT_TYPES),
  parentId: z.string().min(1),
});

export const addAttachmentLinkSchema = z.object({
  parentType: z.enum(PARENT_TYPES),
  parentId: z.string().min(1),
  externalUrl: httpUrlSchema,
  displayLabel: z.string().max(200).optional().or(z.literal('')),
  externalProvider: z.string().max(50).optional(),
  externalProviderId: z.string().max(200).optional(),
});
