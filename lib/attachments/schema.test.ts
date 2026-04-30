import { describe, expect, it } from 'vitest';
import { addAttachmentLinkSchema, uploadAttachmentSchema } from './schema';

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

describe('addAttachmentLinkSchema', () => {
  it('accepts a valid https URL with all fields', () => {
    const r = addAttachmentLinkSchema.safeParse({
      parentType: 'item',
      parentId: 'cuid-1',
      externalUrl: 'https://drive.proton.me/urls/W6X9',
      displayLabel: 'Furnace Manual',
      externalProvider: 'proton-drive',
      externalProviderId: 'abc123',
    });
    expect(r.success).toBe(true);
  });

  it('accepts a valid http URL (self-hosted NAS use case)', () => {
    const r = addAttachmentLinkSchema.safeParse({
      parentType: 'item',
      parentId: 'cuid-1',
      externalUrl: 'http://192.168.1.10:8080/manual.pdf',
    });
    expect(r.success).toBe(true);
  });

  it('accepts an empty displayLabel', () => {
    const r = addAttachmentLinkSchema.safeParse({
      parentType: 'item',
      parentId: 'cuid-1',
      externalUrl: 'https://example.com/x',
      displayLabel: '',
    });
    expect(r.success).toBe(true);
  });

  it('rejects javascript: URLs (XSS hole)', () => {
    const r = addAttachmentLinkSchema.safeParse({
      parentType: 'item',
      parentId: 'cuid-1',
      externalUrl: 'javascript:alert(1)',
    });
    expect(r.success).toBe(false);
  });

  it('rejects data: URLs', () => {
    const r = addAttachmentLinkSchema.safeParse({
      parentType: 'item',
      parentId: 'cuid-1',
      externalUrl: 'data:text/html,<script>alert(1)</script>',
    });
    expect(r.success).toBe(false);
  });

  it('rejects ftp: URLs', () => {
    const r = addAttachmentLinkSchema.safeParse({
      parentType: 'item',
      parentId: 'cuid-1',
      externalUrl: 'ftp://example.com/file.pdf',
    });
    expect(r.success).toBe(false);
  });

  it('rejects empty externalUrl', () => {
    const r = addAttachmentLinkSchema.safeParse({
      parentType: 'item',
      parentId: 'cuid-1',
      externalUrl: '',
    });
    expect(r.success).toBe(false);
  });

  it('rejects unknown parentType', () => {
    const r = addAttachmentLinkSchema.safeParse({
      parentType: 'vendor',
      parentId: 'cuid-1',
      externalUrl: 'https://example.com',
    });
    expect(r.success).toBe(false);
  });
});
