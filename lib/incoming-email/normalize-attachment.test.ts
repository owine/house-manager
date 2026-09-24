import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeInboundAttachment } from './normalize-attachment';

const FIX = join(__dirname, '..', '..', 'tests', 'fixtures');
const PDF = readFileSync(join(FIX, 'sample.pdf'));
const JPG = readFileSync(join(FIX, 'sample.jpg'));
const HTML = Buffer.from('<html><script>alert(1)</script></html>');

const norm = (filename: string | null | undefined, buffer: Buffer) =>
  normalizeInboundAttachment({ filename, buffer, fallbackStem: 'attachment-abc123' });

describe('normalizeInboundAttachment — type', () => {
  it('keeps a real PDF as application/pdf', async () => {
    await expect(norm('invoice.pdf', PDF)).resolves.toEqual({
      filename: 'invoice.pdf',
      mimeType: 'application/pdf',
      storageName: 'original.pdf',
    });
  });

  it('keeps a real JPEG as image/jpeg', async () => {
    await expect(norm('site.jpg', JPG)).resolves.toEqual({
      filename: 'site.jpg',
      mimeType: 'image/jpeg',
      storageName: 'original.jpg',
    });
  });

  // The name says PDF and (in the webhook) the declared type may say PDF.
  // Neither matters: the bytes are HTML.
  it('stores HTML bytes as octet-stream whatever the name claims', async () => {
    await expect(norm('invoice.pdf', HTML)).resolves.toEqual({
      filename: 'invoice.pdf',
      mimeType: 'application/octet-stream',
      storageName: 'original.bin',
    });
  });
});

describe('normalizeInboundAttachment — filename', () => {
  it.each([[null], [undefined], [''], ['   '], ['.'], ['..'], [' .. ']])(
    'generates a name for %j',
    async (filename) => {
      await expect(norm(filename, PDF)).resolves.toMatchObject({
        filename: 'attachment-abc123.pdf',
        storageName: 'original.pdf',
      });
    },
  );

  it('uses .bin for a generated name on unrecognised bytes', async () => {
    await expect(norm(null, HTML)).resolves.toMatchObject({ filename: 'attachment-abc123.bin' });
  });

  it('strips control characters (CR/LF/TAB) from a supplied name', async () => {
    await expect(norm('inv\r\noi\tce.pdf', PDF)).resolves.toMatchObject({
      filename: 'invoice.pdf',
    });
  });

  // U+202E RIGHT-TO-LEFT OVERRIDE makes "invoice\u202Efdp.exe" DISPLAY as
  // "invoiceexe.pdf". Format characters (\p{Cf}) are stripped along with
  // control characters (\p{Cc}).
  it('strips bidi overrides and other format characters from a supplied name', async () => {
    await expect(norm('invoice\u202Efdp.exe', PDF)).resolves.toMatchObject({
      filename: 'invoicefdp.exe',
    });
    await expect(norm('in\u200Bvoice.pdf', PDF)).resolves.toMatchObject({
      filename: 'invoice.pdf',
    });
  });

  // The display name is never used as a path any more, so a traversal-looking
  // name is harmless. What matters is that the storage name is fixed.
  it('never lets the supplied name reach the storage name', async () => {
    await expect(norm('../../etc/passwd', HTML)).resolves.toEqual({
      filename: '../../etc/passwd',
      mimeType: 'application/octet-stream',
      storageName: 'original.bin',
    });
  });
});
