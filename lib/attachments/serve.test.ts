import { describe, expect, it } from 'vitest';
import { fileResponseHeaders } from './serve';

// Hardcoded on purpose: this string is a security control, so a change to it
// should have to change a test too.
const FILE_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

function headersFor(
  mimeType: string | null,
  opts: { isThumbnail?: boolean; filename?: string | null } = {},
) {
  return fileResponseHeaders({
    mimeType,
    filename: opts.filename === undefined ? 'file.bin' : opts.filename,
    isThumbnail: opts.isThumbnail ?? false,
    size: 1234,
  });
}

describe('fileResponseHeaders — what may render inline', () => {
  it.each(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'])(
    'serves %s inline under its own type',
    (mime) => {
      const h = headersFor(mime);
      expect(h.get('content-type')).toBe(mime);
      expect(h.get('content-disposition')).toMatch(/^inline;/);
    },
  );

  it('ignores MIME parameters and case when matching the allow-list', () => {
    const h = headersFor('IMAGE/PNG; charset=binary');
    expect(h.get('content-type')).toBe('image/png');
    expect(h.get('content-disposition')).toMatch(/^inline;/);
  });

  // Thumbnails are produced by our own worker (sharp -> webp), never sender bytes.
  it('serves a thumbnail as inline image/webp whatever the original was', () => {
    const h = headersFor('image/heic', { isThumbnail: true });
    expect(h.get('content-type')).toBe('image/webp');
    expect(h.get('content-disposition')).toMatch(/^inline;/);
  });
});

describe('fileResponseHeaders — everything else is a download', () => {
  it.each([
    'text/html',
    'text/html; charset=utf-8',
    'image/svg+xml',
    'application/xhtml+xml',
    'application/xml',
    'text/xml',
    'text/javascript',
    'application/javascript',
    'image/gif',
    'text/plain',
    'application/octet-stream',
    '',
  ])('serves %j as an application/octet-stream attachment', (mime) => {
    const h = headersFor(mime);
    expect(h.get('content-type')).toBe('application/octet-stream');
    expect(h.get('content-disposition')).toMatch(/^attachment;/);
  });

  it('treats a null mimeType as a download', () => {
    const h = headersFor(null);
    expect(h.get('content-type')).toBe('application/octet-stream');
    expect(h.get('content-disposition')).toMatch(/^attachment;/);
  });
});

describe('fileResponseHeaders — on every response', () => {
  it.each([['application/pdf'], ['text/html'], [null]])(
    '%s gets nosniff + the sandbox CSP',
    (mime) => {
      const h = headersFor(mime);
      expect(h.get('x-content-type-options')).toBe('nosniff');
      expect(h.get('content-security-policy')).toBe(FILE_CSP);
      expect(h.get('cache-control')).toBe('private, max-age=300');
      expect(h.get('content-length')).toBe('1234');
    },
  );
});

describe('fileResponseHeaders — Content-Disposition filename', () => {
  it('sends an ASCII fallback and the exact UTF-8 name (RFC 6266)', () => {
    expect(
      headersFor('application/pdf', { filename: 'invoice.pdf' }).get('content-disposition'),
    ).toBe(`inline; filename="invoice.pdf"; filename*=UTF-8''invoice.pdf`);
    expect(
      headersFor('application/pdf', { filename: 'Rechnung-é.pdf' }).get('content-disposition'),
    ).toBe(`inline; filename="Rechnung-_.pdf"; filename*=UTF-8''Rechnung-%C3%A9.pdf`);
  });

  it('cannot be used to inject a header or break out of the quotes', () => {
    const cd = headersFor('text/html', { filename: 'a"b\r\nSet-Cookie: x.pdf' }).get(
      'content-disposition',
    );
    expect(cd).not.toMatch(/[\r\n]/);
    expect(cd).toBe(
      `attachment; filename="a_b__Set-Cookie: x.pdf"; filename*=UTF-8''a%22b%0D%0ASet-Cookie%3A%20x.pdf`,
    );
  });

  it("percent-encodes the RFC 5987 specials encodeURIComponent leaves alone ( ' ( ) * )", () => {
    expect(
      headersFor('application/pdf', { filename: "it's (1).pdf" }).get('content-disposition'),
    ).toBe(`inline; filename="it's (1).pdf"; filename*=UTF-8''it%27s%20%281%29.pdf`);
  });

  it('never lets a % into the quoted fallback (some clients percent-decode it)', () => {
    expect(headersFor('application/pdf', { filename: '50%.pdf' }).get('content-disposition')).toBe(
      `inline; filename="50_.pdf"; filename*=UTF-8''50%25.pdf`,
    );
  });

  it.each([[null], [''], ['   ']])('falls back to "download" for %j', (filename) => {
    expect(headersFor('application/pdf', { filename }).get('content-disposition')).toBe(
      `inline; filename="download"; filename*=UTF-8''download`,
    );
  });
});
