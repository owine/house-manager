import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ForwardEmailWebhookSchema } from './schema';

const FIX = join(__dirname, '..', '..', 'tests', 'fixtures', 'inbound-email');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIX, name), 'utf8'));
}

describe('ForwardEmailWebhookSchema', () => {
  it('parses the plain-invoice fixture', () => {
    const r = ForwardEmailWebhookSchema.safeParse(loadFixture('invoice-plain.json'));
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.messageId).toBe('<inv-001@acme.example>');
      expect(r.data.from.value[0].address).toBe('billing@acme.example');
      expect(r.data.attachments).toEqual([]);
    }
  });

  it('parses the HTML estimate fixture with two PDF attachments', () => {
    const r = ForwardEmailWebhookSchema.safeParse(loadFixture('estimate-html.json'));
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.attachments).toHaveLength(2);
      expect(r.data.attachments[0].content.data).toEqual([
        104, 101, 108, 108, 111, 32, 119, 111, 114, 108, 100,
      ]);
    }
  });

  it('parses the service-ticket fixture with inline image cid', () => {
    const r = ForwardEmailWebhookSchema.safeParse(loadFixture('ticket-inline-image.json'));
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.attachments[0].cid).toBe('tech-photo');
    }
  });

  it('rejects a payload missing messageId', () => {
    const r = ForwardEmailWebhookSchema.safeParse({
      subject: 'x',
      from: { value: [{ address: 'a@b.example' }] },
    });
    expect(r.success).toBe(false);
  });

  it('rejects an invalid email address in from.value', () => {
    const r = ForwardEmailWebhookSchema.safeParse({
      messageId: '<a@example.com>',
      from: { value: [{ address: 'not-an-email' }] },
    });
    expect(r.success).toBe(false);
  });

  it('rejects an out-of-range byte (256) in attachments[*].content.data', () => {
    const r = ForwardEmailWebhookSchema.safeParse({
      messageId: '<a@example.com>',
      from: { value: [{ address: 'a@b.example' }] },
      attachments: [{ content: { type: 'Buffer', data: [255, 256, 0] } }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects an empty from.value array', () => {
    const r = ForwardEmailWebhookSchema.safeParse({
      messageId: '<a@example.com>',
      from: { value: [] },
    });
    expect(r.success).toBe(false);
  });

  it('passes unknown top-level keys through (.passthrough())', () => {
    const r = ForwardEmailWebhookSchema.safeParse({
      messageId: '<a@example.com>',
      from: { value: [{ address: 'a@b.example' }] },
      // simulating a future FE field we don't model
      newFieldFromForwardEmail: { foo: 'bar' },
    });
    expect(r.success).toBe(true);
  });

  it('defaults attachments to []', () => {
    const r = ForwardEmailWebhookSchema.safeParse({
      messageId: '<a@example.com>',
      from: { value: [{ address: 'a@b.example' }] },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.attachments).toEqual([]);
  });

  it('defaults subject to empty string', () => {
    const r = ForwardEmailWebhookSchema.safeParse({
      messageId: '<a@example.com>',
      from: { value: [{ address: 'a@b.example' }] },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.subject).toBe('');
  });
});
