import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

// The file route is the XSS boundary for every stored file (lib/attachments/
// serve.ts). These tests drive the real webhook and file handlers against a
// real Postgres. They call the handlers directly, so next.config.ts
// `headers()` is NOT applied here. tests/e2e/attachments.spec.ts checks the
// headers a browser actually gets.

const TOKEN = 'test-inbound-token-1234567890ab';
const HMAC_KEY = 'test-hmac-key-1234567890abcdef';
const FILE_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
const FIXTURES = join(__dirname, '..', 'fixtures');
const PDF = readFileSync(join(FIXTURES, 'sample.pdf'));
const JPG = readFileSync(join(FIXTURES, 'sample.jpg'));
const HTML = '<html><body><script>fetch("/settings")</script></body></html>';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>';

let mockedFilesDir = '';
vi.mock('@/lib/env', () => ({
  getEnv: vi.fn(() => ({
    INBOUND_EMAIL_TOKEN: TOKEN,
    INBOUND_EMAIL_HMAC_KEY: HMAC_KEY,
    FILES_DIR: mockedFilesDir,
  })),
}));
vi.mock('@/lib/queue', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/queue')>();
  return {
    ...orig,
    getBoss: vi.fn(async () => ({ send: vi.fn(async () => 'fake-job-id') })),
  };
});
vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => ({ user: { id: 'u1', name: 'Test' } })),
}));

let ctx: IntegrationContext;
let GET: typeof import('@/app/api/files/[id]/route').GET;
let POST: typeof import('@/app/api/inbound-email/[token]/route').POST;
let computeWebhookSignature: typeof import('@/lib/incoming-email/hmac').computeWebhookSignature;

beforeAll(async () => {
  ctx = await setupIntegration();
  mockedFilesDir = mkdtempSync(join(tmpdir(), 'file-route-security-'));
  GET = (await import('@/app/api/files/[id]/route')).GET;
  POST = (await import('@/app/api/inbound-email/[token]/route')).POST;
  computeWebhookSignature = (await import('@/lib/incoming-email/hmac')).computeWebhookSignature;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.attachment.deleteMany();
  await ctx.prisma.incomingEmail.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({ data: { id: 'u1', email: 'u1@example.com', name: 'U1' } });
});

async function getFile(id: string, query = '') {
  return GET(new Request(`http://localhost:3000/api/files/${id}${query}`), {
    params: Promise.resolve({ id }),
  });
}

function expectSandboxedDownload(res: Response) {
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/octet-stream');
  expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('content-security-policy')).toBe(FILE_CSP);
}

/** A row + file exactly as pre-fix ingest left them: the sender's type, verbatim. */
async function seedStoredFile(args: { mimeType: string; filename: string; bytes: Buffer }) {
  const storagePath = join('legacy', randomUUID(), 'file');
  const abs = join(mockedFilesDir, storagePath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, args.bytes);
  return ctx.prisma.attachment.create({
    data: {
      filename: args.filename,
      mimeType: args.mimeType,
      sizeBytes: args.bytes.length,
      storagePath,
      uploadedById: 'u1',
    },
    select: { id: true },
  });
}

/** A mailparser-shaped attachment part as ForwardEmail sends it. */
function part(fields: Record<string, unknown>, bytes: Buffer) {
  return { ...fields, content: { type: 'Buffer', data: Array.from(bytes) } };
}

function email(messageId: string, attachments: unknown[]) {
  return {
    messageId,
    subject: 'Invoice attached',
    from: { value: [{ address: 'billing@acme.example', name: 'Acme HVAC' }] },
    date: '2026-05-08T10:15:00Z',
    text: 'See attached.',
    attachments,
  };
}

async function signedPost(payload: unknown) {
  const body = JSON.stringify(payload);
  const req = new Request(`http://localhost:3000/api/inbound-email/${TOKEN}?raw=false`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-webhook-signature': computeWebhookSignature(body, HMAC_KEY),
    },
    body,
  });
  return POST(req as unknown as Parameters<typeof POST>[0], {
    params: Promise.resolve({ token: TOKEN }),
  });
}

async function attachmentsFor(emailId: string) {
  return ctx.prisma.attachment.findMany({ where: { incomingEmailId: emailId } });
}

function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1;
  }
  return n;
}

describe('GET /api/files/[id] — rows stored before ingest sniffed anything', () => {
  // These rows exist in prod today if anyone ever sent one. No data migration
  // is needed because the route decides at read time.
  it.each([
    ['text/html', 'Invoice-4471.pdf', '<html><script>fetch("/settings")</script></html>'],
    ['text/html; charset=utf-8', 'x.html', '<script>1</script>'],
    [
      'image/svg+xml',
      'photo.svg',
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    ],
    ['text/javascript', 'sw.js', 'self.addEventListener("fetch", () => {})'],
  ])('serves a stored %s as a sandboxed download', async (mimeType, filename, body) => {
    const row = await seedStoredFile({ mimeType, filename, bytes: Buffer.from(body) });
    const res = await getFile(row.id);
    expectSandboxedDownload(res);
    // Neutralized, not destroyed: the user can still download it.
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe(body);
  });

  it('still serves a real PDF and JPEG inline, sandboxed', async () => {
    for (const [mimeType, file] of [
      ['application/pdf', 'sample.pdf'],
      ['image/jpeg', 'sample.jpg'],
    ] as const) {
      const bytes = readFileSync(join(FIXTURES, file));
      const row = await seedStoredFile({ mimeType, filename: file, bytes });
      const res = await getFile(row.id);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(mimeType);
      expect(res.headers.get('content-disposition')).toMatch(/^inline;/);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy')).toBe(FILE_CSP);
      expect(res.headers.get('content-length')).toBe(String(bytes.length));
    }
  });
});

describe('inbound email -> stored attachment -> file route', () => {
  it('stores sender-declared HTML and SVG as octet-stream and serves them as downloads', async () => {
    const res = await signedPost(
      email('<xss-1@attacker.example>', [
        part({ filename: 'Invoice-4471.pdf', contentType: 'text/html' }, Buffer.from(HTML)),
        part({ filename: 'photo.svg', contentType: 'image/svg+xml' }, Buffer.from(SVG)),
        // Lying the other way: declared PDF, actually HTML.
        part({ filename: 'invoice.pdf', contentType: 'application/pdf' }, Buffer.from(HTML)),
      ]),
    );
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };

    const rows = await attachmentsFor(id);
    expect(rows).toHaveLength(3);
    // The sender's names survive for display. They are just never a path or a type.
    expect(rows.map((r) => r.filename).sort()).toEqual([
      'Invoice-4471.pdf',
      'invoice.pdf',
      'photo.svg',
    ]);
    for (const row of rows) {
      expect(row.mimeType).toBe('application/octet-stream');
      expect(row.storagePath).toMatch(/\/original\.bin$/);
      expectSandboxedDownload(await getFile(row.id));
    }
  });

  it('ingests parts with no filename or content type instead of 500-ing (A-H2)', async () => {
    const res = await signedPost(
      email('<nameless-1@acme.example>', [
        part({}, Buffer.from(HTML)), // no filename, no contentType: was a CHECK violation -> 500
        part({ filename: null }, JPG), // null filename: was a CHECK violation -> 500
        part({ filename: 'scan.pdf', contentType: null }, PDF), // null contentType: was a Zod 400
        part({ filename: '..', contentType: 'application/pdf' }, PDF), // was rename-onto-dir -> 500
      ]),
    );
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };

    const rows = await attachmentsFor(id);
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.filename).toBeTruthy();
      expect(row.mimeType).toBeTruthy();
      expect(row.storagePath).toMatch(/\/original\.(bin|jpg|pdf)$/);
    }
    expect(rows.map((r) => r.mimeType).sort()).toEqual([
      'application/octet-stream',
      'application/pdf',
      'application/pdf',
      'image/jpeg',
    ]);
    expect(rows.find((r) => r.mimeType === 'image/jpeg')?.filename).toMatch(
      /^attachment-\w+\.jpg$/,
    );
    expect(rows.find((r) => r.mimeType === 'application/octet-stream')?.filename).toMatch(
      /^attachment-\w+\.bin$/,
    );
    expect(
      rows
        .filter((r) => r.mimeType === 'application/pdf')
        .map((r) => r.filename)
        .sort(),
    ).toEqual([expect.stringMatching(/^attachment-\w+\.pdf$/), 'scan.pdf']);
  });

  it('keeps a real PDF and JPEG renderable inline', async () => {
    const res = await signedPost(
      email('<real-1@acme.example>', [
        part({ filename: 'invoice.pdf', contentType: 'application/pdf' }, PDF),
        part({ filename: 'site.jpg', contentType: 'image/jpeg' }, JPG),
      ]),
    );
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };

    const rows = await attachmentsFor(id);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const expected = row.filename === 'invoice.pdf' ? 'application/pdf' : 'image/jpeg';
      expect(row.mimeType).toBe(expected);
      const file = await getFile(row.id);
      expect(file.headers.get('content-type')).toBe(expected);
      expect(file.headers.get('content-disposition')).toMatch(/^inline;/);
      expect(file.headers.get('x-content-type-options')).toBe('nosniff');
      expect(file.headers.get('content-security-policy')).toBe(FILE_CSP);
    }
  });

  it('removes the files it wrote when the database write fails', async () => {
    // Warm ingest's memoized uploader id with a normal delivery, then delete
    // that user so the attachment insert fails its FK. This stands in for any
    // DB failure that turns into a 500 and a ForwardEmail retry.
    const warm = await signedPost(email('<warm-1@acme.example>', []));
    expect(warm.status).toBe(200);
    await ctx.prisma.incomingEmail.deleteMany();
    await ctx.prisma.user.deleteMany();

    const before = countFiles(join(mockedFilesDir, 'inbound'));
    const res = await signedPost(
      email('<doomed-1@acme.example>', [
        part({ filename: 'a.pdf', contentType: 'application/pdf' }, PDF),
        part({ filename: 'b.jpg' }, JPG),
      ]),
    );
    expect(res.status).toBe(500);
    expect(await ctx.prisma.incomingEmail.count()).toBe(0);
    // Without cleanup every retry leaves another full copy on disk.
    expect(countFiles(join(mockedFilesDir, 'inbound'))).toBe(before);
  });
});
