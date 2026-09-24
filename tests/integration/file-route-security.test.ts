import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

// The file route is the XSS boundary for every stored file (lib/attachments/
// serve.ts). These tests call the real handler against rows in a real Postgres.
// They call GET() directly, so next.config.ts `headers()` is NOT applied here.
// tests/e2e/attachments.spec.ts checks the headers a browser actually gets.

const FILE_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
const FIXTURES = join(__dirname, '..', 'fixtures');

let mockedFilesDir = '';
vi.mock('@/lib/env', () => ({
  getEnv: vi.fn(() => ({ FILES_DIR: mockedFilesDir })),
}));
vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => ({ user: { id: 'u1', name: 'Test' } })),
}));

let ctx: IntegrationContext;
let GET: typeof import('@/app/api/files/[id]/route').GET;

beforeAll(async () => {
  ctx = await setupIntegration();
  mockedFilesDir = mkdtempSync(join(tmpdir(), 'file-route-security-'));
  GET = (await import('@/app/api/files/[id]/route')).GET;
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
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe(FILE_CSP);
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
