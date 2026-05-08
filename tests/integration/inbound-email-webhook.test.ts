import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import estimateFixture from '../fixtures/inbound-email/estimate-html.json';
import invoiceFixture from '../fixtures/inbound-email/invoice-plain.json';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

const TOKEN = 'test-inbound-token-1234567890ab';
const HMAC_KEY = 'test-hmac-key-1234567890abcdef';

const enqueued: Array<{ queue: string; data: unknown }> = [];

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
    getBoss: vi.fn(async () => ({
      send: vi.fn(async (queue: string, data: unknown) => {
        enqueued.push({ queue, data });
        return 'fake-job-id';
      }),
    })),
  };
});

let ctx: IntegrationContext;
let POST: typeof import('@/app/api/inbound-email/[token]/route').POST;
let computeWebhookSignature: typeof import('@/lib/incoming-email/hmac').computeWebhookSignature;
let filesDir: string;

beforeAll(async () => {
  ctx = await setupIntegration();
  filesDir = mkdtempSync(join(tmpdir(), 'inbound-email-test-'));
  mockedFilesDir = filesDir;
  const route = await import('@/app/api/inbound-email/[token]/route');
  POST = route.POST;
  const hmac = await import('@/lib/incoming-email/hmac');
  computeWebhookSignature = hmac.computeWebhookSignature;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  enqueued.length = 0;
  await ctx.prisma.attachment.deleteMany();
  await ctx.prisma.incomingEmail.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({ data: { id: 'u1', email: 'u1@example.com', name: 'U1' } });
});

function makeRequest(body: string, opts: { token?: string; sig?: string | null } = {}) {
  const token = opts.token ?? TOKEN;
  const url = `http://localhost:3000/api/inbound-email/${token}?raw=false`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.sig !== null) {
    headers['x-webhook-signature'] = opts.sig ?? computeWebhookSignature(body, HMAC_KEY);
  }
  return new Request(url, { method: 'POST', headers, body });
}

async function callRoute(req: Request, token: string) {
  return POST(req as unknown as Parameters<typeof POST>[0], {
    params: Promise.resolve({ token }),
  });
}

describe('POST /api/inbound-email/[token]', () => {
  it('persists a plain-invoice payload and enqueues a classify job', async () => {
    const body = JSON.stringify(invoiceFixture);
    const req = makeRequest(body);
    const res = await callRoute(req, TOKEN);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { id: string; duplicate: boolean };
    expect(json.duplicate).toBe(false);

    const row = await ctx.prisma.incomingEmail.findUnique({
      where: { id: json.id },
      include: { attachments: true },
    });
    expect(row).not.toBeNull();
    expect(row?.messageId).toBe('<inv-001@acme.example>');
    expect(row?.attachments).toHaveLength(0);
    expect(enqueued).toEqual([{ queue: 'incoming-email.classify', data: { id: json.id } }]);
  });

  it('persists attachments from the HTML-estimate fixture', async () => {
    const body = JSON.stringify(estimateFixture);
    const res = await callRoute(makeRequest(body), TOKEN);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { id: string };

    const attachments = await ctx.prisma.attachment.findMany({
      where: { incomingEmailId: json.id },
      orderBy: { filename: 'asc' },
    });
    expect(attachments).toHaveLength(2);
    expect(attachments.map((a) => a.filename).sort()).toEqual(['estimate-4831.pdf', 'scope.pdf']);
    expect(attachments[0].uploadedById).toBe('u1');
  });

  it('rejects with 401 on token mismatch', async () => {
    const body = JSON.stringify(invoiceFixture);
    const res = await callRoute(
      makeRequest(body, { token: 'wrong-token-1234567890xx' }),
      'wrong-token-1234567890xx',
    );
    expect(res.status).toBe(401);
    const count = await ctx.prisma.incomingEmail.count();
    expect(count).toBe(0);
  });

  it('rejects with 401 when the X-Webhook-Signature header is missing', async () => {
    const body = JSON.stringify(invoiceFixture);
    const res = await callRoute(makeRequest(body, { sig: null }), TOKEN);
    expect(res.status).toBe(401);
    expect(await ctx.prisma.incomingEmail.count()).toBe(0);
  });

  it('rejects with 401 when the body is tampered after signing', async () => {
    const body = JSON.stringify(invoiceFixture);
    const sig = computeWebhookSignature(body, HMAC_KEY);
    const tampered = `${body} `;
    const res = await callRoute(makeRequest(tampered, { sig }), TOKEN);
    expect(res.status).toBe(401);
    expect(await ctx.prisma.incomingEmail.count()).toBe(0);
  });

  it('returns duplicate=true on a re-delivery of the same Message-ID', async () => {
    const body = JSON.stringify(invoiceFixture);
    const r1 = await callRoute(makeRequest(body), TOKEN);
    const j1 = (await r1.json()) as { id: string; duplicate: boolean };
    const r2 = await callRoute(makeRequest(body), TOKEN);
    const j2 = (await r2.json()) as { id: string; duplicate: boolean };
    expect(j1.duplicate).toBe(false);
    expect(j2.duplicate).toBe(true);
    expect(j2.id).toBe(j1.id);
    expect(await ctx.prisma.incomingEmail.count()).toBe(1);
    // Only the first delivery enqueues a classify job; duplicates are no-ops.
    expect(enqueued).toHaveLength(1);
  });

  it('rejects with 413 when the body exceeds 25 MB', async () => {
    // Construct a body just over the cap. We don't sign it correctly because
    // size check happens before HMAC; signing would still be wasted CPU.
    const huge = 'x'.repeat(25 * 1024 * 1024 + 1);
    const url = `http://localhost:3000/api/inbound-email/${TOKEN}`;
    const req = new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: huge,
    });
    const res = await callRoute(req, TOKEN);
    expect(res.status).toBe(413);
  }, 30_000);

  it('rejects with 400 on invalid JSON', async () => {
    const body = 'not-json{{{';
    const res = await callRoute(makeRequest(body), TOKEN);
    expect(res.status).toBe(400);
  });

  it('rejects with 400 on a Zod-invalid payload (missing messageId)', async () => {
    const body = JSON.stringify({ from: { value: [{ address: 'a@b.example' }] } });
    const res = await callRoute(makeRequest(body), TOKEN);
    expect(res.status).toBe(400);
    expect(await ctx.prisma.incomingEmail.count()).toBe(0);
  });
});
