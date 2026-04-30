import { describe, expect, it } from 'vitest';
import { uploadAttachmentSchema } from './schema';

describe('uploadAttachmentSchema', () => {
  it.each([
    'item',
    'warranty',
    'serviceRecord',
    'note',
  ] as const)('accepts parentType=%s with a non-empty parentId', (parentType) => {
    const r = uploadAttachmentSchema.safeParse({ parentType, parentId: 'cuid-123' });
    expect(r.success).toBe(true);
  });

  it('rejects unknown parentType', () => {
    const r = uploadAttachmentSchema.safeParse({ parentType: 'vendor', parentId: 'x' });
    expect(r.success).toBe(false);
  });

  it('rejects empty parentId', () => {
    const r = uploadAttachmentSchema.safeParse({ parentType: 'item', parentId: '' });
    expect(r.success).toBe(false);
  });
});
