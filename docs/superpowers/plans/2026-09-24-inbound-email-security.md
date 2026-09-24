# Inbound Email Security Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the external-sender → stored-XSS chain (review findings S-H1, S-H2, S-M1, A-H1, A-H2). An email sent to the inbox alias must not be able to run script in the app's origin, must not be able to write a service record without a human unless the sender is DMARC-authenticated, and must not be able to wedge the webhook in a 500/retry loop.

**Architecture:** Three layers, in the order they are built:
1. **Serve time (primary fix).** `GET /api/files/[id]` stops trusting `Attachment.mimeType`. A pure header builder in `lib/attachments/serve.ts` renders inline only a raster/PDF allow-list and turns everything else into an `application/octet-stream` download, always with `nosniff` and a sandboxing CSP. Because it decides at *read* time, it neutralizes rows already in the database — no data migration.
2. **Ingest time (defense in depth).** `ingestIncomingEmail` ignores the sender's declared `Content-Type` and filename for anything security-relevant: the stored type is sniffed from the bytes with the `file-type` package the user-upload path already uses, the on-disk name is always `original.<ext>`, and a missing/degenerate filename gets a generated one. That also removes the DB CHECK violation behind the A-H2 retry loop, and failed ingests now clean up the files they wrote.
3. **Auto-stub gate.** Both auto-stub predicates (`shouldAutoStub` for the AI path, `classifyEmail` for the heuristic fallback) take a new `dmarcPassed` input, read fail-closed from the stored mailauth result. Plus global security headers in `next.config.ts`.

**Tech Stack:** Next.js 16.3 route handlers + `next.config.ts` `headers()`, Prisma 7 / Postgres 18, Zod 4, `file-type` 22 (already a production dependency), Vitest 5 (unit + Testcontainers integration), Playwright.

---

## Background the implementer needs

**The trust model you are fixing.** The inbound webhook (`app/api/inbound-email/[token]/route.ts`) checks a URL token and an HMAC. Both authenticate **ForwardEmail**, not the person who sent the email. Anyone who knows the inbox address controls the body, every attachment's bytes, its filename, its declared `Content-Type`, and the `From:` header. Treat every field of the webhook payload as attacker input.

**The chain, verified against the code at `b7a87cd`:**
- `lib/incoming-email/ingest.ts:74-79` stores `mimeType: att.contentType ?? null` verbatim.
- `app/api/files/[id]/route.ts:42-49` serves that type with `Content-Disposition: inline`, no `nosniff`, no CSP. A `text/html` or `image/svg+xml` "attachment" therefore runs script same-origin with the user's session.
- `lib/incoming-email/create-service-record.ts:72-75` re-parents every email attachment onto the service record, where `components/attachments/AttachmentCard.tsx:81-104` makes it a clickable link.
- `worker/jobs/classify-incoming-email.ts:193-212` does that re-parenting with **no human involved** (`autoStub`) whenever `shouldAutoStub` (`lib/incoming-email/ai-classify.ts:168-181`) passes. All four of its inputs are model outputs. The heuristic fallback (`worker/jobs/classify-incoming-email.ts:363`, rule in `lib/incoming-email/classify.ts:262`) has its **own** auto-stub rule, driven by an exact `From:` match on `Vendor.email`, which a spoofed `From:` satisfies. An attacker can reach that path by making the AI call fail. **Both gates must get the DMARC check.**
- SPF/DKIM/DMARC are stored in `IncomingEmail.authResultsJson` (`ingest.ts:86-90`) and read nowhere.

**What ForwardEmail actually sends in `dmarc`.** ForwardEmail's MX (`forwardemail/forwardemail.net`, `helpers/is-authenticated-message.js`) runs mailauth's `authenticate()` and sets `session.dmarc = results.dmarc`; `helpers/on-data-mx.js` then builds the webhook body as `{ ...mail, dkim: session.dkim, spf: session.spf, arc: session.arc, dmarc: session.dmarc, ... }`. mailauth's DMARC result (`postalsys/mailauth` `docs/dmarc.md`) is an object whose verdict is at **`status.result`**, one of `pass | fail | none | temperror`. `none` means the domain publishes no DMARC record. mailauth can also return boolean `false` for structurally invalid mail, but ForwardEmail rejects that at SMTP time (550), so it should never reach us. Ingest stores it as `authResultsJson = { dkim, spf, dmarc }`, so the path to read is `authResultsJson.dmarc.status.result`. The checked-in fixture `tests/fixtures/inbound-email/invoice-plain.json` uses a made-up shape (`"dmarc": { "result": "pass" }`). Task 6 corrects it.

**A Next.js behaviour this plan depends on. Read it before touching `next.config.ts`.** Entries from `headers()` in `next.config.ts` are written to the Node response by the router *before* a route handler runs (`node_modules/next/dist/server/lib/router-server.js`, the "apply any response headers from routing" block). When the handler's `Response` is copied onto the Node response, `node_modules/next/dist/server/send-response.js` **skips every header that is already present** ("only append the header if it is either not present in the outbound response…"). The only exceptions are `set-cookie`, `www-authenticate`, `proxy-authenticate` and `vary`. So **a global header from `next.config.ts` silently beats a route's own header of the same name.** A global `Content-Security-Policy: frame-ancestors 'none'` would therefore *delete* the file route's sandbox CSP. That is why Task 8 scopes the CSP/frame headers to `'/((?!api/files/).*)'`. The pattern was checked with Next's own `getPathMatch` and `checkCustomRoutes`: it matches `/`, `/items/abc`, `/api/health`, `/_next/static/...` and `/api/filesx`, and does not match `/api/files/<id>`. Integration tests call route handlers directly and **never see `next.config.ts` headers**. Only the e2e test in Task 8 sees what a browser gets.

**Do NOT create `proxy.ts`.** Once a proxy exists, Next buffers request bodies up to `proxyClientMaxBodySize` (default 10 MB) and truncates the rest (`node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/proxyClientMaxBodySize.md`). Inbound webhooks run up to 50 MB, so HMAC verification would fail on every large email. This is also why a script-restricting CSP is deferred: with RSC it needs per-request nonces, which need a proxy.

**PDFs under a sandbox CSP: the evidence behind `FILE_CSP`.** The file route's policy is `default-src 'none'; style-src 'unsafe-inline'; sandbox`, which Redmine has served on every attachment for years:
- Redmine #40647 (redmine.org/issues/40647): with exactly this header, inline PDFs work in Chrome and Firefox. Safari 17.4 failed. Safari **18.4** (released 2025-03-31) fixed it via the WebKit change "Main frame PDFs served with CSP sandbox header do not load".
- Chrome and Firefox both exempt their built-in viewer from the page's CSP (Chromium issue 40328564, Mozilla bug 1582115, verified fixed in Firefox 77/78).
- The older "sandbox breaks PDF" reports (Chromium 413851 / 41131921) concern PDFs inside **sandboxed iframes** and the retired PPAPI plugin. That is not a top-level navigation, which is how `AttachmentCard` opens files (`target="_blank"`).
- The accepted cost: Safari ≤ 18.3 shows a sandboxed PDF as blank. Task 10 has a manual cross-browser check, with a documented fallback if it fails.
- `X-Frame-Options`/`frame-ancestors` are deliberately **not** applied to `/api/files/*`. Chrome's out-of-process PDF viewer puts the PDF in an internal frame. Whether it tolerates `frame-ancestors 'none'` on the PDF response is unverified, and a sandboxed download or image has nothing to clickjack.

**Repo gotchas that apply here** (from `CLAUDE.md`):
- `pnpm`, never `npx`/`npm`. Run one test file with `pnpm exec vitest run <path>`. **Not** `pnpm test:unit <path>`, which *widens* the run.
- Integration tests use Testcontainers (`tests/integration/setup.ts`). **Docker must be running.** Each suite starts its own Postgres and Meilisearch, so `docker compose up -d db meilisearch` is not required for them.
- `vi.mock` is hoisted per file and cannot live in a shared module. Every integration file declares its own mocks, and routes are imported dynamically in `beforeAll` *after* `setupIntegration()` has set `DATABASE_URL`, or `lib/db` binds to the wrong database.
- `app/**/*.test.ts` is **not** in the Vitest include (only `app/**/*.test.tsx`). That is one reason the header logic lives in `lib/attachments/serve.ts`: it gets colocated unit tests and coverage there.
- `lint:knip` fails on unused exports. Every new export below has a production consumer.
- `lint:worker-graph` checks that everything the worker imports ships in the runtime image. The new `lib/incoming-email/auth-results.ts` only imports `zod`, which is already a production dependency on the worker graph.
- Code blocks in this plan are not guaranteed to be Biome-formatted: some lines exceed the 100-column limit. Run `pnpm lint:fix` before each commit, and if Biome rewrites a file, `git add` it again. Biome's formatter check is part of `pnpm lint`.
- Never `--no-verify`. **`git commit` can fail silently behind the Biome pre-commit hook: after every commit, run `git log --oneline -1` and confirm HEAD moved.** Commits are SSH-signed automatically; don't pass `--author` or touch signing config.
- `git add` explicit paths only. Never `-A` or `.`.
- Do not use a git worktree for this work. In this repo knip hangs in worktrees (pre-push never finishes), and the missing `.env` breaks `prisma generate`/typecheck in misleading ways. Use the main checkout.
- Calendar dates vs instants: this plan touches no `@db.Date` column. Leave the existing `startOfDayUtc` calls in the worker alone.

## Findings corrected on inspection

- **A-H2 is slightly overstated for `contentType`.** The schema has `contentType: z.string().optional()`, not `.nullable()`. An *absent* content type reaches the DB as `null` and violates the CHECK (500, retry loop, as reported). An *explicit* `null` fails Zod and returns **400**: the email is dropped, not retried. Filename `null`/absent → 500 is accurate. So are `.`, `..` and `''` as filenames: `safeName` keeps them, `path.join(dir, '..')` makes the `rename` target a directory, `atomicWrite` throws, and the route returns 500. The CHECK is exactly `("storagePath" IS NULL) OR ((filename IS NOT NULL) AND ("mimeType" IS NOT NULL) AND ("sizeBytes" IS NOT NULL))` (`prisma/migrations/000000000000_squashed_migrations/migration.sql:733-738`).
- **S-H2 understates the attack surface.** The heuristic fallback has its own auto-stub gate (`classifyEmail().shouldAutoStubServiceRecord`), which the finding does not mention. Gating only `shouldAutoStub` would leave that path open, so this plan gates both.
- **The review's suggested per-route CSP would have been silently discarded** if a global CSP were later added in `next.config.ts` (see "A Next.js behaviour" above). The plan scopes around it and adds an e2e test for it.
- **The review's caveat that "`sandbox` has been reported to break Chrome's built-in PDF viewer" is out of date** for top-level navigations (see the evidence above). The plan applies the sandbox to PDFs too.

## File structure

| File | Responsibility |
|---|---|
| `lib/attachments/serve.ts` *(create)* | Pure `fileResponseHeaders()`: the inline allow-list, the download fallback, `nosniff`, the sandbox CSP, RFC 6266 `Content-Disposition`. The XSS boundary as code. |
| `lib/attachments/serve.test.ts` *(create)* | Unit tests for every branch of the header policy. |
| `app/api/files/[id]/route.ts` *(modify, lines 1-6 and 41-52)* | Uses `fileResponseHeaders()` instead of hand-built headers. |
| `lib/attachments/mime.ts` *(modify, append after line 34)* | `OCTET_STREAM` constant + `sniffAllowedMime()`: bytes → allow-listed type or octet-stream. |
| `lib/attachments/mime.test.ts` *(modify, append)* | Tests for `sniffAllowedMime`. |
| `lib/incoming-email/normalize-attachment.ts` *(create)* | Pure-ish: sender's `{filename, bytes}` → `{filename, mimeType, storageName}` safe to store. |
| `lib/incoming-email/normalize-attachment.test.ts` *(create)* | Unit tests incl. `.`, `..`, empty, control characters, lying types. |
| `lib/incoming-email/ingest.ts` *(modify, lines 1-8 and 55-148)* | Uses the normalizer; removes the files it wrote when the ingest fails. |
| `lib/incoming-email/schema.ts` *(modify, line 33)* | `contentType` becomes `.nullable().optional()`. |
| `lib/incoming-email/schema.test.ts` *(modify, append)* | Null-`contentType` acceptance. |
| `tests/integration/file-route-security.test.ts` *(create)* | Webhook → DB → file route, end to end, against real Postgres. |
| `tests/integration/inbound-email-webhook.test.ts` *(modify, lines 1-7, 89-96, 105-111)* | Stored-type and stored-auth-results assertions. |
| `lib/incoming-email/auth-results.ts` *(create)* | `dmarcResult()` / `dmarcPassed()`: fail-closed reader for the stored mailauth verdict. |
| `lib/incoming-email/auth-results.test.ts` *(create)* | Unit tests incl. every fail-closed shape and a fixture-drift guard. |
| `tests/fixtures/inbound-email/invoice-plain.json` *(modify, lines 18-20)* | Real mailauth shape for `dkim`/`spf`/`dmarc`. |
| `lib/incoming-email/ai-classify.ts` *(modify, lines 163-181)* | `shouldAutoStub` gains `dmarcPassed`. |
| `lib/incoming-email/ai-classify.test.ts` *(modify, lines 34-58)* | DMARC gate cases. |
| `lib/incoming-email/classify.ts` *(modify, lines 9-11, 23-38, 262)* | Heuristic auto-stub rule gains `dmarcPassed`. |
| `lib/incoming-email/classify.test.ts` *(modify, lines 35-46, 356-411)* | DMARC gate case. |
| `worker/jobs/classify-incoming-email.ts` *(modify, lines 9-17, 53-62, 193-223, 306-377)* | Reads `authResultsJson`, feeds both gates, logs the verdict. |
| `tests/integration/incoming-email-classify-job.test.ts` *(modify, lines 1-10, 67-85, append)* | Default DMARC-pass seed; DMARC fail/missing/legacy-shape/heuristic tests. |
| `next.config.ts` *(modify, lines 4-28)* | `poweredByHeader: false` + `headers()`. |
| `tests/e2e/attachments.spec.ts` *(modify, append)* | `@critical` test of the headers a browser actually receives. |
| `CLAUDE.md` *(modify, insert after line 327)* | Inbound-email trust model + the `headers()` precedence trap. |

---

### Task 0: Branch

- [ ] **Step 1: Start from an up-to-date main, in the main checkout (no worktree)**

```bash
git checkout main
git pull --ff-only
git checkout -b fix/inbound-email-security
git status --short   # expect: clean
```

---

### Task 1: The file-route header policy as a pure function

**Files:**
- Create: `lib/attachments/serve.ts`
- Test: `lib/attachments/serve.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `lib/attachments/serve.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fileResponseHeaders } from './serve';

// Hardcoded on purpose: this string is a security control, so a change to it
// should have to change a test too.
const FILE_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

function headersFor(mimeType: string | null, opts: { isThumbnail?: boolean; filename?: string | null } = {}) {
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
  it.each([['application/pdf'], ['text/html'], [null]])('%s gets nosniff + the sandbox CSP', (mime) => {
    const h = headersFor(mime);
    expect(h.get('x-content-type-options')).toBe('nosniff');
    expect(h.get('content-security-policy')).toBe(FILE_CSP);
    expect(h.get('cache-control')).toBe('private, max-age=300');
    expect(h.get('content-length')).toBe('1234');
  });
});

describe('fileResponseHeaders — Content-Disposition filename', () => {
  it('sends an ASCII fallback and the exact UTF-8 name (RFC 6266)', () => {
    expect(headersFor('application/pdf', { filename: 'invoice.pdf' }).get('content-disposition')).toBe(
      `inline; filename="invoice.pdf"; filename*=UTF-8''invoice.pdf`,
    );
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
    expect(headersFor('application/pdf', { filename: "it's (1).pdf" }).get('content-disposition')).toBe(
      `inline; filename="it's (1).pdf"; filename*=UTF-8''it%27s%20%281%29.pdf`,
    );
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
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm exec vitest run lib/attachments/serve.test.ts
```

Expected: FAIL. `Failed to resolve import "./serve"`.

- [ ] **Step 3: Implement**

Create `lib/attachments/serve.ts`:

```ts
import { OCTET_STREAM } from './mime';

/**
 * Response headers for `GET /api/files/[id]`: the XSS boundary for every stored
 * file.
 *
 * `Attachment.mimeType` is NOT trusted here. For inbound email it was the
 * sender's own `Content-Type` until ingest started sniffing bytes, and old rows
 * still carry whatever the sender claimed (`text/html`, `image/svg+xml`, ...).
 * Deciding at read time is what neutralizes those rows without a migration.
 *
 * NOTE: a header of the same name set in `next.config.ts` `headers()` REPLACES
 * the one set here. Next writes config headers first and then skips any
 * route-handler header that is already present
 * (node_modules/next/dist/server/send-response.js). Keep global CSP / framing
 * headers scoped away from /api/files/.
 */

/**
 * Types a browser may RENDER in our origin. Each is a raster image or a PDF:
 * formats that run no script in the page's origin. Everything else a sender
 * can name (SVG, HTML, XML, JS, ...) is served as a download. This is an
 * allow-list and must stay one.
 *
 * Deliberately separate from ALLOWED_MIME (what uploads accept), even though
 * the two match today: widening uploads must not silently widen what renders.
 */
const INLINE_SAFE_MIME: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
]);

/**
 * `sandbox` gives the document a unique opaque origin with scripts, forms and
 * plugins disabled, so even a file a browser chooses to render can't act as the
 * signed-in user. `default-src 'none'` stops it loading anything. The
 * `style-src 'unsafe-inline'` is for the synthetic wrapper page browsers build
 * around a top-level image or PDF.
 *
 * This exact policy is the one Redmine serves attachments with. Chrome and
 * Firefox render PDFs under it (both exempt their built-in viewer from page CSP:
 * Chromium issue 40328564, Mozilla bug 1582115). Safari does from 18.4 (Redmine
 * #40647). Safari <= 18.3 shows such a PDF blank, which is the accepted cost.
 */
const FILE_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

function normalizeMime(mimeType: string | null): string {
  return (mimeType ?? '').split(';')[0].trim().toLowerCase();
}

/**
 * RFC 6266: a quoted ASCII fallback for old clients, then the exact UTF-8 name
 * in `filename*`. The fallback replaces anything outside printable ASCII
 * (including CR/LF), plus `"` and `\` (which would break the quoted string) and
 * `%` (which some clients percent-decode inside it).
 */
function contentDisposition(kind: 'inline' | 'attachment', filename: string | null): string {
  const name = filename?.trim() ? filename : 'download';
  const fallback = name.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function fileResponseHeaders(input: {
  mimeType: string | null;
  filename: string | null;
  isThumbnail: boolean;
  size: number;
}): Headers {
  let renderable: string | null = null;
  if (input.isThumbnail) {
    // Thumbnails are generated by our worker (sharp -> webp), not sender bytes.
    renderable = 'image/webp';
  } else {
    const stored = normalizeMime(input.mimeType);
    if (INLINE_SAFE_MIME.has(stored)) renderable = stored;
  }

  const headers = new Headers();
  headers.set('Content-Type', renderable ?? OCTET_STREAM);
  headers.set('Content-Length', String(input.size));
  headers.set(
    'Content-Disposition',
    contentDisposition(renderable ? 'inline' : 'attachment', input.filename),
  );
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', FILE_CSP);
  headers.set('Cache-Control', 'private, max-age=300');
  return headers;
}
```

`OCTET_STREAM` does not exist in `./mime` yet. Add it now as part of this task, at the end of `lib/attachments/mime.ts` (after line 34):

```ts

/** The type for bytes we will not let a browser interpret. */
export const OCTET_STREAM = 'application/octet-stream';
```

- [ ] **Step 4: Run it and watch it pass**

```bash
pnpm exec vitest run lib/attachments/serve.test.ts lib/attachments/mime.test.ts
```

Expected: PASS (both files).

- [ ] **Step 5: Commit**

```bash
git add lib/attachments/serve.ts lib/attachments/serve.test.ts lib/attachments/mime.ts
git commit -m "feat(files): add allow-list header policy for the file route"
git log --oneline -1   # verify HEAD moved; the Biome pre-commit hook can fail silently
```

---

### Task 2: Wire the policy into `GET /api/files/[id]` (primary S-H1 fix)

**Files:**
- Modify: `app/api/files/[id]/route.ts` (imports lines 1-6; header block lines 39-52)
- Test: `tests/integration/file-route-security.test.ts` (create; Task 5 extends it)

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/file-route-security.test.ts`:

```ts
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
    ['image/svg+xml', 'photo.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
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
```

- [ ] **Step 2: Run it and watch it fail** (Docker must be running)

```bash
pnpm exec vitest run tests/integration/file-route-security.test.ts
```

Expected: FAIL. The legacy cases fail with `expected 'text/html' to be 'application/octet-stream'` (and the SVG/JS equivalents). The PDF/JPEG case fails on `x-content-type-options` (`expected null to be 'nosniff'`).

- [ ] **Step 3: Implement**

In `app/api/files/[id]/route.ts`, add the import. Keep Biome's import order: `@/lib/attachments/queries` < `@/lib/attachments/serve` < `@/lib/attachments/storage`.

```ts
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { getAttachment } from '@/lib/attachments/queries';
import { fileResponseHeaders } from '@/lib/attachments/serve';
import { openReadStream, resolveStoragePath } from '@/lib/attachments/storage';
import { auth } from '@/lib/auth';
import { getEnv } from '@/lib/env';
```

Replace lines 39-52 (from `const stream = openReadStream(absPath);` to the closing `}` of `GET`) with:

```ts
  const stream = openReadStream(absPath);
  const body = Readable.toWeb(stream) as ReadableStream;
  // Every security-relevant header comes from one audited place. The stored
  // mimeType is sender-controlled for inbound email, so it is only a hint.
  const headers = fileResponseHeaders({
    mimeType: row.mimeType,
    filename: row.filename,
    isThumbnail: wantThumb,
    size,
  });

  return new Response(body, { status: 200, headers });
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
pnpm exec vitest run tests/integration/file-route-security.test.ts
pnpm typecheck
```

Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add "app/api/files/[id]/route.ts" tests/integration/file-route-security.test.ts
git commit -m "fix(files): serve non-allow-listed types as sandboxed downloads"
git log --oneline -1
```

---

### Task 3: `sniffAllowedMime` for untrusted bytes

**Files:**
- Modify: `lib/attachments/mime.ts` (append after the `OCTET_STREAM` export added in Task 1)
- Test: `lib/attachments/mime.test.ts` (append)

Reuse the `file-type` detection the user-upload path already relies on (`verifyMagicBytes`). Do not add a dependency. These results were probed against the installed `file-type@22.1.1`: 3–4 byte JPEG headers, `%PDF-1.4 fake`, 16-byte PNG, `RIFF....WEBPVP8 `, and an `ftypheic` box are detected; bare HTML and bare `<svg>` return `undefined`; `<?xml …><svg>` returns `application/xml`; `GIF89a` returns `image/gif`.

- [ ] **Step 1: Write the failing test**

Append to `lib/attachments/mime.test.ts`, and add `sniffAllowedMime` to the existing import on line 2 (`import { ALLOWED_MIME, extensionFor, sniffAllowedMime, verifyMagicBytes } from './mime';`):

```ts

describe('sniffAllowedMime', () => {
  it.each([
    ['JPEG', Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg'],
    ['PDF', Buffer.from('%PDF-1.4 fake'), 'application/pdf'],
    [
      'PNG',
      Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52,
      ]),
      'image/png',
    ],
  ])('returns the detected type for allow-listed %s bytes', async (_label, buf, mime) => {
    await expect(sniffAllowedMime(buf)).resolves.toBe(mime);
  });

  // The sender's declared Content-Type is never an input. These are the
  // payloads S-H1 was about; none of them may come back as a renderable type.
  it.each([
    ['bare HTML', Buffer.from('<html><script>alert(1)</script></html>')],
    ['bare SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ['XML-prologue SVG', Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['GIF (detected, but not allow-listed)', Buffer.from('GIF89a......')],
    ['unrecognised bytes', Buffer.from('hello world')],
    ['an empty buffer', Buffer.alloc(0)],
  ])('returns application/octet-stream for %s', async (_label, buf) => {
    await expect(sniffAllowedMime(buf)).resolves.toBe('application/octet-stream');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm exec vitest run lib/attachments/mime.test.ts
```

Expected: FAIL. `sniffAllowedMime is not a function` (the import resolves to `undefined`).

- [ ] **Step 3: Implement**

Append to `lib/attachments/mime.ts`, after the `OCTET_STREAM` export:

```ts

/**
 * The type to STORE for bytes from someone we don't trust: what the magic
 * bytes say, if that is one of ALLOWED_MIME, else `application/octet-stream`.
 * A declared Content-Type is deliberately not a parameter. For inbound email
 * it is the sender's claim, and that claim is the whole S-H1 attack.
 */
export async function sniffAllowedMime(buf: Buffer): Promise<string> {
  const detected = await fileTypeFromBuffer(buf);
  return detected && ALLOWED_MIME.has(detected.mime) ? detected.mime : OCTET_STREAM;
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
pnpm exec vitest run lib/attachments/mime.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/attachments/mime.ts lib/attachments/mime.test.ts
git commit -m "feat(attachments): add sniffAllowedMime for untrusted bytes"
git log --oneline -1
```

---

### Task 4: Normalize an inbound attachment before it touches disk or DB

**Files:**
- Create: `lib/incoming-email/normalize-attachment.ts`
- Test: `lib/incoming-email/normalize-attachment.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `lib/incoming-email/normalize-attachment.test.ts`:

```ts
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
    await expect(norm('inv\r\noi\tce.pdf', PDF)).resolves.toMatchObject({ filename: 'invoice.pdf' });
  });

  // U+202E RIGHT-TO-LEFT OVERRIDE makes "invoice\u202Efdp.exe" DISPLAY as
  // "invoiceexe.pdf". Format characters (\p{Cf}) are stripped along with
  // control characters (\p{Cc}).
  it('strips bidi overrides and other format characters from a supplied name', async () => {
    await expect(norm('invoice\u202Efdp.exe', PDF)).resolves.toMatchObject({
      filename: 'invoicefdp.exe',
    });
    await expect(norm('in\u200Bvoice.pdf', PDF)).resolves.toMatchObject({ filename: 'invoice.pdf' });
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
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm exec vitest run lib/incoming-email/normalize-attachment.test.ts
```

Expected: FAIL. `Failed to resolve import "./normalize-attachment"`.

- [ ] **Step 3: Implement**

Create `lib/incoming-email/normalize-attachment.ts`:

```ts
import { extensionFor, OCTET_STREAM, sniffAllowedMime } from '@/lib/attachments/mime';

// Not exported: knip flags exported types with no importer.
type NormalizedInboundAttachment = {
  /** Shown in the UI and sent in Content-Disposition. Never used as a path. */
  filename: string;
  /** Sniffed from the bytes. The sender's declared Content-Type is ignored. */
  mimeType: string;
  /** On-disk basename. A fixed shape, so no sender input reaches the filesystem. */
  storageName: string;
};

/**
 * Everything an email sender controls about an attachment, reduced to values
 * that are safe to store.
 *
 * - The type comes from the bytes (allow-listed, else octet-stream). The
 *   declared Content-Type was the S-H1 vector.
 * - The on-disk name is always `original.<ext>`, as for user uploads. The
 *   sender's name used to be written to disk, and `.`, `..` or `''` made
 *   `atomicWrite` rename onto a directory: a 500 that ForwardEmail retried
 *   forever (A-H2).
 * - A missing or degenerate display name gets a generated one, which also
 *   satisfies the `Attachment_file_metadata_required` CHECK (no null filename
 *   or mimeType on a stored file).
 */
export async function normalizeInboundAttachment(input: {
  filename: string | null | undefined;
  buffer: Buffer;
  /** Used when the supplied name is unusable, e.g. `attachment-<id>`. */
  fallbackStem: string;
}): Promise<NormalizedInboundAttachment> {
  const mimeType = await sniffAllowedMime(input.buffer);
  const ext = mimeType === OCTET_STREAM ? 'bin' : extensionFor(mimeType);
  // \p{Cc}: control chars (CR/LF/TAB/NUL). \p{Cf}: format chars, incl. bidi
  // overrides like U+202E that make "x\u202Efdp.exe" display as "xexe.pdf".
  const cleaned = (input.filename ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  const filename =
    cleaned === '' || cleaned === '.' || cleaned === '..' ? `${input.fallbackStem}.${ext}` : cleaned;
  return { filename, mimeType, storageName: `original.${ext}` };
}
```

(`extensionFor` cannot throw here: `sniffAllowedMime` only ever returns a member of `ALLOWED_MIME` or `OCTET_STREAM`, and every `ALLOWED_MIME` member has an extension in `EXT_BY_MIME`.)

- [ ] **Step 4: Run it and watch it pass**

```bash
pnpm exec vitest run lib/incoming-email/normalize-attachment.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/incoming-email/normalize-attachment.ts lib/incoming-email/normalize-attachment.test.ts
git commit -m "feat(inbound-email): normalize attachment name, type and storage name"
git log --oneline -1
```

---

### Task 5: Use the normalizer at ingest; stop the retry loop leaking files

**Files:**
- Modify: `lib/incoming-email/ingest.ts` (imports lines 1-8; body lines 55-148)
- Modify: `lib/incoming-email/schema.ts` (line 33)
- Modify: `lib/incoming-email/schema.test.ts` (append inside the `describe`)
- Modify: `tests/integration/inbound-email-webhook.test.ts` (lines 105-111)
- Modify: `tests/integration/file-route-security.test.ts` (full replacement below)

- [ ] **Step 1: Write the failing tests**

(a) In `lib/incoming-email/schema.test.ts`, add this case inside `describe('ForwardEmailWebhookSchema', …)`, before its closing `});`:

```ts

  // An explicit null Content-Type used to be a Zod 400, which means the email
  // was dropped. Ingest never reads the declared type now (it sniffs the
  // bytes), so there is nothing to reject.
  it('accepts an attachment whose filename and contentType are null', () => {
    const r = ForwardEmailWebhookSchema.safeParse({
      messageId: '<a@example.com>',
      from: { value: [{ address: 'a@b.example' }] },
      attachments: [
        { filename: null, contentType: null, content: { type: 'Buffer', data: [1, 2, 3] } },
      ],
    });
    expect(r.success).toBe(true);
  });
```

(b) In `tests/integration/inbound-email-webhook.test.ts`, extend the estimate test (lines 105-111). Insert after `expect(attachments[0].uploadedById).toBe('u1');`:

```ts
    // The fixture's "PDFs" are the bytes of "hello world" / "ABCDE": not PDFs.
    // Ingest stores what the bytes are, not what the sender claimed.
    expect(attachments.map((a) => a.mimeType)).toEqual([
      'application/octet-stream',
      'application/octet-stream',
    ]);
```

(c) **Replace the whole of** `tests/integration/file-route-security.test.ts` with the version below. It keeps Task 2's tests unchanged and adds the webhook-driven chain:

```ts
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
    ['image/svg+xml', 'photo.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
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
    expect(rows.map((r) => r.filename).sort()).toEqual(['Invoice-4471.pdf', 'invoice.pdf', 'photo.svg']);
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
    expect(rows.find((r) => r.mimeType === 'image/jpeg')?.filename).toMatch(/^attachment-\w+\.jpg$/);
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
```

- [ ] **Step 2: Run them and watch them fail**

```bash
pnpm exec vitest run lib/incoming-email/schema.test.ts
pnpm exec vitest run tests/integration/file-route-security.test.ts tests/integration/inbound-email-webhook.test.ts
```

Expected:
- `schema.test.ts`: the new case fails (`expected false to be true`, because `contentType: null` is rejected).
- `file-route-security`: the two legacy cases pass (Task 2). "HTML and SVG" fails: `expected 'text/html' to be 'application/octet-stream'`. "no filename" fails: `expected 500 to be 200` (or 400, because of the null `contentType` part). "real PDF" may already pass. "removes the files" fails: the file count grows by 2.
- `inbound-email-webhook`: the estimate case fails: `expected [ 'application/pdf', … ] to deeply equal [ 'application/octet-stream', … ]`.

- [ ] **Step 3: Implement**

(a) `lib/incoming-email/schema.ts` line 33. Change:

```ts
          contentType: z.string().optional(),
```

to:

```ts
          // Accepted but never trusted: ingest sniffs the bytes instead
          // (normalize-attachment.ts). Nullable so a null doesn't 400 the email.
          contentType: z.string().nullable().optional(),
```

(b) `lib/incoming-email/ingest.ts`. Replace the import block (lines 1-8):

```ts
import { createId } from '@paralleldrive/cuid2';
import { Prisma } from '@prisma/client';
import { atomicWrite, removeDir } from '@/lib/attachments/storage';
import { prisma } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { getLogger } from '@/lib/logger';
import { enqueueSearchIndex } from '@/lib/search/client';
import { normalizeInboundAttachment } from './normalize-attachment';
import type { ForwardEmailWebhookBody } from './schema';
```

Then replace everything from line 55 (`// Decode every attachment to a Buffer up-front…`) to the end of the file (line 148) with:

```ts
  const fromAddress = parsed.from.value[0].address;
  const fromName = parsed.from.value[0].name ?? null;
  const receivedAt = parsed.date ?? new Date();
  const headersJson = (parsed.headers ?? {}) as Prisma.InputJsonValue;
  const authResultsJson = {
    dkim: parsed.dkim ?? null,
    spf: parsed.spf ?? null,
    dmarc: parsed.dmarc ?? null,
  } as Prisma.InputJsonValue;

  // Every attachment directory this call creates. If anything below fails they
  // are removed before the error propagates. The webhook then answers 500 and
  // ForwardEmail retries, and without this each retry would leave another full
  // copy of the attachments on disk with no row pointing at it.
  const writtenDirs: string[] = [];

  let created: { email: { id: string }; attachmentIds: string[] };
  try {
    // Write every attachment before the DB insert: if a write fails we'd
    // rather fail before persisting half a row.
    const attachmentWrites: Array<{
      storagePath: string;
      filename: string;
      mimeType: string;
      sizeBytes: number;
    }> = [];

    for (const att of parsed.attachments) {
      const buffer = Buffer.from(att.content.data);
      const id = createId();
      const dir = `inbound/${id.slice(0, 2)}/${id}`;
      // The sender controls this part's filename and Content-Type, and neither
      // is trusted: the stored type comes from the bytes, the on-disk name is
      // fixed, and a missing/degenerate name gets a generated one.
      const normalized = await normalizeInboundAttachment({
        filename: att.filename,
        buffer,
        fallbackStem: `attachment-${id}`,
      });
      writtenDirs.push(dir);
      const storagePath = await atomicWrite(env.FILES_DIR, dir, normalized.storageName, buffer);
      attachmentWrites.push({
        storagePath,
        filename: normalized.filename,
        mimeType: normalized.mimeType,
        sizeBytes: att.size ?? buffer.length,
      });
    }

    created = await prisma.$transaction(async (tx) => {
      const email = await tx.incomingEmail.create({
        data: {
          messageId: parsed.messageId,
          fromAddress,
          fromName,
          subject: parsed.subject,
          receivedAt,
          bodyText: parsed.text ?? null,
          bodyHtml: parsed.html ?? null,
          headersJson,
          authResultsJson,
        },
        select: { id: true },
      });
      const attachmentIds: string[] = [];
      if (attachmentWrites.length > 0) {
        // createMany doesn't return rows; re-select by the unique parent edge.
        await tx.attachment.createMany({
          data: attachmentWrites.map((a) => ({
            incomingEmailId: email.id,
            uploadedById,
            ...a,
          })),
        });
        const rows = await tx.attachment.findMany({
          where: { incomingEmailId: email.id },
          select: { id: true },
        });
        attachmentIds.push(...rows.map((r) => r.id));
      }
      return { email, attachmentIds };
    });
  } catch (err) {
    // Nothing we wrote is referenced: either the transaction never ran or it
    // rolled back.
    await Promise.all(
      writtenDirs.map((dir) => removeDir(env.FILES_DIR, dir).catch(() => {})),
    );
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // TOCTOU: a concurrent retry of the same Message-ID committed first.
      // Surface the existing row instead of erroring. Its own attachments are
      // on disk; ours were just removed above.
      log.warn(
        { messageId: parsed.messageId },
        'inbound-email: concurrent insert race resolved via existing row',
      );
      const winner = await prisma.incomingEmail.findUnique({
        where: { messageId: parsed.messageId },
        select: { id: true },
      });
      if (winner) return { id: winner.id, duplicate: true };
    }
    throw err;
  }

  // Outside the try on purpose: a failure here must never delete files that
  // committed rows point at. (enqueueSearchIndex swallows its own errors anyway.)
  for (const id of created.attachmentIds) {
    await enqueueSearchIndex('attachment', id, 'upsert');
  }
  return { id: created.email.id, duplicate: false };
}
```

- [ ] **Step 4: Run them and watch them pass**

```bash
pnpm exec vitest run lib/incoming-email lib/attachments
pnpm exec vitest run tests/integration/file-route-security.test.ts tests/integration/inbound-email-webhook.test.ts
pnpm typecheck
```

Expected: PASS; typecheck clean. (`tests/unit/lib/embed-drift.test.ts` and `search-index-drift.test.ts` allow-list `lib/incoming-email/ingest.ts`. The Prisma writes are still in that file, so run `pnpm exec vitest run tests/unit/lib` too and expect PASS.)

- [ ] **Step 5: Commit**

```bash
git add lib/incoming-email/ingest.ts lib/incoming-email/schema.ts lib/incoming-email/schema.test.ts tests/integration/file-route-security.test.ts tests/integration/inbound-email-webhook.test.ts
git commit -m "fix(inbound-email): sniff attachment types at ingest and stop the CHECK retry loop"
git log --oneline -1
```

---

### Task 6: A fail-closed DMARC reader, and fixtures in mailauth's real shape

**Files:**
- Create: `lib/incoming-email/auth-results.ts`
- Test: `lib/incoming-email/auth-results.test.ts` (create)
- Modify: `tests/fixtures/inbound-email/invoice-plain.json` (lines 18-20)
- Modify: `tests/integration/inbound-email-webhook.test.ts` (imports lines 1-7; invoice test lines 89-96)

- [ ] **Step 1: Write the failing test**

Create `lib/incoming-email/auth-results.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dmarcPassed, dmarcResult } from './auth-results';

// Trimmed from mailauth docs/dmarc.md "DMARC Pass". ForwardEmail copies
// mailauth's `results.dmarc` into the webhook's `dmarc` field verbatim, and
// ingest stores it as authResultsJson.dmarc.
const MAILAUTH_PASS = {
  status: {
    result: 'pass',
    comment: 'p=REJECT',
    header: { from: 'acme.example', d: 'acme.example' },
  },
  domain: 'acme.example',
  policy: 'reject',
  p: 'reject',
  sp: 'reject',
  info: 'dmarc=pass (p=REJECT) header.from=acme.example',
};

/** The shape ingest writes: `{ dkim, spf, dmarc }`. */
const stored = (dmarc: unknown) => ({ dkim: null, spf: null, dmarc });

describe('dmarcPassed', () => {
  it('is true for mailauth’s pass shape', () => {
    expect(dmarcPassed(stored(MAILAUTH_PASS))).toBe(true);
  });

  // Fail-closed: the price of a false negative is one email that waits in
  // triage; the price of a false positive is a stranger writing service history.
  it.each([
    ['DMARC fail', stored({ ...MAILAUTH_PASS, status: { result: 'fail', comment: 'p=NONE' } })],
    ['none (sender publishes no DMARC record)', stored({ status: { result: 'none' }, domain: 'x.example', info: 'dmarc=none' })],
    ['temperror', stored({ status: { result: 'temperror' }, domain: 'x.example', info: '' })],
    ['uppercase PASS (mailauth never emits it)', stored({ status: { result: 'PASS' } })],
    ['the pre-fix fixture shape { result: "pass" }', stored({ result: 'pass' })],
    ['a bare "pass" string', stored('pass')],
    ['mailauth false (structurally invalid)', stored(false)],
    ['dmarc: null', stored(null)],
    ['no dmarc key', { dkim: null, spf: null }],
    ['a non-string result', stored({ status: { result: true } })],
    ['a null column', null],
    ['undefined', undefined],
    ['a non-object column', 'pass'],
  ])('is false for %s', (_label, value) => {
    expect(dmarcPassed(value)).toBe(false);
  });
});

describe('dmarcResult', () => {
  it('returns the raw verdict for logging', () => {
    expect(dmarcResult(stored({ status: { result: 'fail' } }))).toBe('fail');
  });

  it('returns null when the stored shape is not mailauth’s', () => {
    expect(dmarcResult(stored({ result: 'pass' }))).toBeNull();
    expect(dmarcResult(null)).toBeNull();
  });
});

describe('the invoice-plain fixture', () => {
  // This fixture once carried a made-up `{ result: 'pass' }`, which the gate
  // correctly reads as NOT passed. Keep it honest.
  it('carries a DMARC pass in mailauth’s real shape', () => {
    const path = join(__dirname, '..', '..', 'tests', 'fixtures', 'inbound-email', 'invoice-plain.json');
    const fixture = JSON.parse(readFileSync(path, 'utf8')) as { dmarc: unknown };
    expect(dmarcPassed({ dmarc: fixture.dmarc })).toBe(true);
  });
});
```

In `tests/integration/inbound-email-webhook.test.ts`, add this import after line 4 (the `vitest` import; Biome orders `@/` before relative paths):

```ts
import { dmarcPassed } from '@/lib/incoming-email/auth-results';
```

And in the first test (`'persists a plain-invoice payload and enqueues a classify job'`), after `expect(row?.messageId).toBe('<inv-001@acme.example>');` (line 94) add:

```ts
    // Ingest stores ForwardEmail's auth results where the classify job's
    // DMARC gate reads them.
    expect(dmarcPassed(row?.authResultsJson)).toBe(true);
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm exec vitest run lib/incoming-email/auth-results.test.ts
```

Expected: FAIL. `Failed to resolve import "./auth-results"`.

- [ ] **Step 3: Implement**

Create `lib/incoming-email/auth-results.ts`:

```ts
import { z } from 'zod';

/**
 * Sender authentication for inbound email, read from `IncomingEmail.
 * authResultsJson`, which `ingestIncomingEmail` writes as `{ dkim, spf, dmarc }`.
 *
 * Those are ForwardEmail's mailauth results, passed through verbatim.
 * ForwardEmail's MX runs `mailauth.authenticate()` and copies `results.dmarc`
 * into the webhook body as `dmarc` (forwardemail.net helpers/
 * is-authenticated-message.js + on-data-mx.js). mailauth's DMARC verdict lives
 * at `status.result`: 'pass' | 'fail' | 'none' | 'temperror' (mailauth
 * docs/dmarc.md).
 *
 * FAIL-CLOSED. Only the exact string 'pass' at that path counts. A null
 * column, a missing key, mailauth's `false`, `none` (no DMARC record) and any
 * other shape all read as "not authenticated".
 */
const storedDmarcSchema = z.object({
  dmarc: z.object({
    status: z.object({ result: z.string() }),
  }),
});

/** The raw DMARC verdict, or null when the stored value isn't mailauth-shaped. For logs. */
export function dmarcResult(authResultsJson: unknown): string | null {
  const parsed = storedDmarcSchema.safeParse(authResultsJson);
  return parsed.success ? parsed.data.dmarc.status.result : null;
}

/** True only when ForwardEmail recorded a DMARC pass for this message. */
export function dmarcPassed(authResultsJson: unknown): boolean {
  return dmarcResult(authResultsJson) === 'pass';
}
```

Replace lines 18-20 of `tests/fixtures/inbound-email/invoice-plain.json` (the three `"dkim"`/`"spf"`/`"dmarc"` lines) with mailauth-shaped objects:

```json
  "dkim": {
    "headerFrom": ["billing@acme.example"],
    "envelopeFrom": "billing@acme.example",
    "results": [
      {
        "signingDomain": "acme.example",
        "selector": "s1",
        "status": { "result": "pass", "header": { "i": "@acme.example", "s": "s1" } },
        "info": "dkim=pass header.i=@acme.example header.s=s1"
      }
    ]
  },
  "spf": {
    "domain": "acme.example",
    "status": {
      "result": "pass",
      "comment": "domain of billing@acme.example designates 192.0.2.10 as permitted sender"
    },
    "info": "spf=pass smtp.mailfrom=billing@acme.example"
  },
  "dmarc": {
    "status": {
      "result": "pass",
      "comment": "p=REJECT",
      "header": { "from": "acme.example", "d": "acme.example" }
    },
    "domain": "acme.example",
    "policy": "reject",
    "p": "reject",
    "sp": "reject",
    "rr": "v=DMARC1; p=reject",
    "info": "dmarc=pass (p=REJECT) header.from=acme.example"
  },
```

(Keep the following `"session": …` line and the closing brace unchanged. Only `invoice-plain.json` carries auth results; `estimate-html.json` and `ticket-inline-image.json` have none, which is fine because no test auto-stubs from them.)

- [ ] **Step 4: Run it and watch it pass**

```bash
pnpm exec vitest run lib/incoming-email/auth-results.test.ts lib/incoming-email/schema.test.ts
pnpm exec vitest run tests/integration/inbound-email-webhook.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/incoming-email/auth-results.ts lib/incoming-email/auth-results.test.ts tests/fixtures/inbound-email/invoice-plain.json tests/integration/inbound-email-webhook.test.ts
git commit -m "feat(inbound-email): add fail-closed DMARC reader; use mailauth's real result shape in fixtures"
git log --oneline -1
```

---

### Task 7: Require DMARC pass before auto-stubbing (both gates + the worker)

This is one task because changing the gate signatures breaks the worker's typecheck until it is wired. Every commit must typecheck.

**Files:**
- Modify: `lib/incoming-email/ai-classify.ts` (lines 163-181)
- Modify: `lib/incoming-email/ai-classify.test.ts` (lines 34-58)
- Modify: `lib/incoming-email/classify.ts` (lines 9-11, 23-38, 262)
- Modify: `lib/incoming-email/classify.test.ts` (lines 35-46; the `auto-stub gating` describe at 356-411)
- Modify: `worker/jobs/classify-incoming-email.ts` (imports 9-17; select 53-62; gate + log 193-223; `heuristicFallback` 306-377)
- Modify: `tests/integration/incoming-email-classify-job.test.ts` (imports 1-10; `makeEmail` 67-85; append a `describe`)

- [ ] **Step 1: Write the failing unit tests**

In `lib/incoming-email/ai-classify.test.ts`, replace the `base` object (lines 35-40) with:

```ts
  const base = {
    vendorId: 'v1',
    targetItemId: 'i1',
    targetSystemId: null,
    confidence: 'high' as const,
    dmarcPassed: true,
  };
```

and add this case before the `describe`'s closing `});` (after line 57):

```ts
  // Every other input is a model output that the email body can steer; this
  // is the one a sender can't forge.
  it('does not stub when the sender did not pass DMARC, however sure the model is', () => {
    expect(shouldAutoStub({ ...base, kind: 'TICKET', dmarcPassed: false })).toBe(false);
    expect(shouldAutoStub({ ...base, kind: 'INVOICE', dmarcPassed: false })).toBe(false);
  });
```

In `lib/incoming-email/classify.test.ts`, add `dmarcPassed: true,` to the `input()` defaults (between `systems: [SYSTEM_HVAC],` and `...overrides,`, around line 44):

```ts
    systems: [SYSTEM_HVAC],
    dmarcPassed: true,
    ...overrides,
```

and add this case inside `describe('classifyEmail — auto-stub gating', …)` before its closing `});`:

```ts

  // The heuristic fallback is reachable by making the AI call fail, and its
  // vendor match is an exact From: match, which spoofing satisfies.
  it('does NOT fire when the sender did not pass DMARC', () => {
    const r = classifyEmail(
      input({
        fromAddress: 'dispatch@acme.example',
        subject: 'Service report — Heat Pump',
        dmarcPassed: false,
      }),
    );
    // Classification is unchanged; only the auto-draft is withheld.
    expect(r.kind).toBe('TICKET');
    expect(r.vendorId).toBe('v_acme');
    expect(r.targets[0]?.itemId).toBe('i_hp');
    expect(r.shouldAutoStubServiceRecord).toBe(false);
  });
```

- [ ] **Step 2: Run them and watch them fail**

```bash
pnpm exec vitest run lib/incoming-email/ai-classify.test.ts lib/incoming-email/classify.test.ts
```

Expected: FAIL. Both new cases: `expected true to be false`. (Vitest doesn't typecheck, so the extra field runs; `pnpm typecheck` would also flag it.)

- [ ] **Step 3: Implement the pure gates**

`lib/incoming-email/ai-classify.ts`: replace lines 163-181 (the doc comment and `shouldAutoStub`) with:

```ts
/**
 * Confidence floor for auto-stubbing a ServiceRecord from an inbound email:
 * a high-confidence INVOICE or TICKET with a matched vendor AND a matched
 * target (item or system), from a sender that passed DMARC. Anything weaker
 * stays in the triage queue.
 */
export function shouldAutoStub(input: {
  kind: 'ESTIMATE' | 'INVOICE' | 'TICKET' | 'UNKNOWN';
  vendorId: string | null;
  targetItemId: string | null;
  targetSystemId: string | null;
  confidence: 'low' | 'medium' | 'high';
  /**
   * `dmarcPassed(row.authResultsJson)` (./auth-results). Every other field is
   * a MODEL OUTPUT that whoever wrote the email can steer. This is the one
   * input decided outside the message. Without it, a spoofed `From:` of a
   * real vendor writes a service record with no human in the loop.
   */
  dmarcPassed: boolean;
}): boolean {
  return (
    input.dmarcPassed &&
    (input.kind === 'TICKET' || input.kind === 'INVOICE') &&
    input.confidence === 'high' &&
    !!input.vendorId &&
    (!!input.targetItemId || !!input.targetSystemId)
  );
}
```

`lib/incoming-email/classify.ts`:
- Lines 9-11 of the header comment. Replace:

```ts
 * Confidence floor for auto-stubbing a ServiceRecord: all three of
 * (kind=TICKET, vendor matched, item-or-system matched). Anything weaker
 * stays in the triage queue for the user.
```

with:

```ts
 * Confidence floor for auto-stubbing a ServiceRecord: all four of
 * (kind=TICKET, vendor matched, item-or-system matched, sender passed DMARC).
 * Anything weaker stays in the triage queue for the user.
```

- In `ClassifyInput` (lines 23-38), add after `systems: ClassifyEntity[];`:

```ts
  /**
   * Whether the sender passed DMARC (`dmarcPassed` in ./auth-results). Gates
   * only `shouldAutoStubServiceRecord`: an unauthenticated email is still
   * classified, just never auto-drafted. The vendor match above trusts the
   * From: header, which is exactly what DMARC authenticates.
   */
  dmarcPassed: boolean;
```

- Line 262. Replace:

```ts
  const shouldAutoStubServiceRecord = kind === 'TICKET' && vendor !== null && targets.length > 0;
```

with:

```ts
  const shouldAutoStubServiceRecord =
    input.dmarcPassed && kind === 'TICKET' && vendor !== null && targets.length > 0;
```

- [ ] **Step 4: Run the unit tests and watch them pass**

```bash
pnpm exec vitest run lib/incoming-email
```

Expected: PASS. (`pnpm typecheck` now FAILS in `worker/jobs/classify-incoming-email.ts`, which is missing `dmarcPassed`. The next steps fix that.)

- [ ] **Step 5: Write the failing integration tests**

In `tests/integration/incoming-email-classify-job.test.ts`:

Add the Prisma type import at the top (Biome orders `@prisma/client` before `vitest`). The first lines become:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
```

Replace `makeEmail` (lines 67-85) with:

```ts
// ForwardEmail's mailauth results as ingest stores them (`{ dkim, spf, dmarc }`).
// See lib/incoming-email/auth-results.ts for the shape.
const DMARC_PASS: Prisma.InputJsonValue = {
  dkim: null,
  spf: null,
  dmarc: { status: { result: 'pass', comment: 'p=REJECT' }, domain: 'acme.example', policy: 'reject' },
};
const DMARC_FAIL: Prisma.InputJsonValue = {
  dkim: null,
  spf: null,
  dmarc: { status: { result: 'fail', comment: 'p=NONE' }, domain: 'acme.example', policy: 'none' },
};

async function makeEmail(args: {
  messageId: string;
  fromAddress?: string;
  fromName?: string;
  subject: string;
  bodyText?: string;
  /**
   * Stored authResultsJson. Defaults to a DMARC pass so the pre-existing
   * auto-stub tests keep exercising the path they were written for; `null`
   * stores no auth results at all.
   */
  authResults?: Prisma.InputJsonValue | null;
}) {
  return ctx.prisma.incomingEmail.create({
    data: {
      messageId: args.messageId,
      fromAddress: args.fromAddress ?? 'billing@acme.example',
      fromName: args.fromName ?? 'Acme HVAC',
      subject: args.subject,
      bodyText: args.bodyText ?? null,
      receivedAt: new Date('2026-05-08T12:00:00Z'),
      headersJson: {},
      ...(args.authResults === null ? {} : { authResultsJson: args.authResults ?? DMARC_PASS }),
    },
  });
}
```

The three existing tests that expect an auto-stub all go through `makeEmail`, so they pick up the passing default: "high-confidence INVOICE…", "auto-stub links the email attachments…" and "AI throws → heuristic fallback…". Nothing else in them changes. The "preserves user-set LINKED state" test creates its row directly and already has a `createdServiceRecordId`, so it never reaches the gate.

Append at the end of the file:

```ts

// S-H2: a stranger's email must not write a service record with no human in
// the loop. Every other auto-stub input is steerable by the email body.
describe('handleClassifyIncomingEmail — DMARC gate on auto-stub', () => {
  async function arrangeHighConfidenceInvoice(
    messageId: string,
    authResults: Prisma.InputJsonValue | null,
  ) {
    const v = await ctx.prisma.vendor.create({
      data: { name: 'Acme HVAC', email: 'billing@acme.example' },
    });
    const item = await ctx.prisma.item.create({ data: { name: 'Heat Pump', categoryId } });
    mockResponse = {
      parsed_output: {
        kind: 'INVOICE',
        vendorId: v.id,
        targetItemId: item.id,
        targetSystemId: null,
        confidence: 'high',
        summary: 'Heat pump spring tune-up',
        cost: 185.0,
        performedOn: '2026-04-15',
        scope: 'Replaced air filter; cleaned coils.',
        rationale: 'Clear invoice from known vendor.',
      },
      usage: {},
    };
    const e = await makeEmail({
      messageId,
      subject: 'Invoice #5512 for Heat Pump service',
      bodyText: 'Amount due $185.',
      authResults,
    });
    return { e, v, item };
  }

  async function expectClassifiedButNotStubbed(emailId: string, vendorId: string, itemId: string) {
    const after = await ctx.prisma.incomingEmail.findUnique({
      where: { id: emailId },
      include: { targets: true },
    });
    // Classification still lands, so the user sees the suggestion in triage...
    expect(after?.kind).toBe('INVOICE');
    expect(after?.vendorId).toBe(vendorId);
    expect(after?.targets[0].itemId).toBe(itemId);
    expect(after?.state).toBe('AUTO_LINKED');
    // ...but nothing was written on the sender's say-so.
    expect(after?.createdServiceRecordId).toBeNull();
    expect(await ctx.prisma.serviceRecord.count()).toBe(0);
  }

  it('DMARC pass -> auto-stubs (control)', async () => {
    const { e } = await arrangeHighConfidenceInvoice('<dmarc-pass@a>', DMARC_PASS);
    await handle([{ data: { id: e.id } }]);
    const after = await ctx.prisma.incomingEmail.findUnique({ where: { id: e.id } });
    expect(after?.createdServiceRecordId).not.toBeNull();
    expect(after?.state).toBe('LINKED');
  });

  it('DMARC fail -> classifies but does NOT auto-stub', async () => {
    const { e, v, item } = await arrangeHighConfidenceInvoice('<dmarc-fail@a>', DMARC_FAIL);
    await handle([{ data: { id: e.id } }]);
    await expectClassifiedButNotStubbed(e.id, v.id, item.id);
  });

  it('no stored auth results -> does NOT auto-stub (fail-closed)', async () => {
    const { e, v, item } = await arrangeHighConfidenceInvoice('<dmarc-missing@a>', null);
    await handle([{ data: { id: e.id } }]);
    await expectClassifiedButNotStubbed(e.id, v.id, item.id);
  });

  it('the old fixture shape { result: "pass" } -> does NOT auto-stub (fail-closed)', async () => {
    const { e, v, item } = await arrangeHighConfidenceInvoice('<dmarc-legacy@a>', {
      dkim: null,
      spf: null,
      dmarc: { result: 'pass' },
    });
    await handle([{ data: { id: e.id } }]);
    await expectClassifiedButNotStubbed(e.id, v.id, item.id);
  });

  it('the heuristic fallback honours the gate too', async () => {
    const v = await ctx.prisma.vendor.create({
      data: { name: 'Acme HVAC', email: 'dispatch@acme.example' },
    });
    const item = await ctx.prisma.item.create({ data: { name: 'Heat Pump', categoryId } });
    // Force the fallback, which an attacker can also do (e.g. a PDF that
    // blows the token ceiling).
    mockResponse = () => {
      throw Object.assign(new Error('rate limited'), { status: 429 });
    };
    const e = await makeEmail({
      messageId: '<dmarc-fail-heuristic@a>',
      fromAddress: 'dispatch@acme.example', // exact Vendor.email match: what spoofing buys
      subject: 'Service ticket — visit complete',
      bodyText: 'Performed maintenance on the Heat Pump today.',
      authResults: DMARC_FAIL,
    });

    await handle([{ data: { id: e.id } }]);

    const after = await ctx.prisma.incomingEmail.findUnique({
      where: { id: e.id },
      include: { targets: true },
    });
    expect(after?.kind).toBe('TICKET');
    expect(after?.vendorId).toBe(v.id);
    expect(after?.targets[0].itemId).toBe(item.id);
    expect(after?.state).toBe('AUTO_LINKED');
    expect(after?.createdServiceRecordId).toBeNull();
    expect(await ctx.prisma.serviceRecord.count()).toBe(0);
  });
});
```

- [ ] **Step 6: Run the integration tests and watch the gate cases fail**

```bash
pnpm exec vitest run tests/integration/incoming-email-classify-job.test.ts
```

Expected: FAIL. "DMARC fail", "no stored auth results", "old fixture shape" and "heuristic fallback honours the gate" fail on `expected 'cm…' to be null` / `expected 'LINKED' to be 'AUTO_LINKED'`, because the worker still ignores DMARC. The control and all pre-existing cases pass.

- [ ] **Step 7: Wire the worker**

`worker/jobs/classify-incoming-email.ts`:

Imports (lines 9-14). Add the auth-results import between `ai-classify` and `classify`:

```ts
import {
  aiClassifyExtract,
  shouldAutoStub,
  validateCandidateIds,
} from '@/lib/incoming-email/ai-classify';
import { dmarcPassed, dmarcResult } from '@/lib/incoming-email/auth-results';
import { classifyEmail } from '@/lib/incoming-email/classify';
```

The `select` in `classifyOne` (lines 53-62): add `authResultsJson: true,` after `createdServiceRecordId: true,`:

```ts
    select: {
      id: true,
      fromAddress: true,
      fromName: true,
      subject: true,
      bodyText: true,
      receivedAt: true,
      state: true,
      createdServiceRecordId: true,
      // ForwardEmail's SPF/DKIM/DMARC verdicts, as stored at ingest. The DMARC
      // result is the one auto-stub input the email's author can't steer.
      authResultsJson: true,
    },
```

Replace the gate and its `else` log (lines 193-223) with:

```ts
    if (
      shouldAutoStub({
        kind: result.kind,
        vendorId,
        targetItemId,
        targetSystemId,
        confidence: result.confidence,
        dmarcPassed: dmarcPassed(row.authResultsJson),
      }) &&
      !row.createdServiceRecordId
    ) {
      await autoStub({
        rowId: row.id,
        vendorId,
        targets,
        // `receivedAt` is an instant. Reduce it to the house day, or an email
        // received at 8pm Chicago files the service record under TOMORROW.
        performedOn: aiPerformedOn ?? startOfDayUtc(row.receivedAt, await getHouseTimezone()),
        summary: result.summary ?? fallbackSummary(row.subject),
        notes: result.scope ?? AUTO_NOTE,
      });
    } else {
      log.info(
        {
          id: row.id,
          kind: result.kind,
          confidence: result.confidence,
          vendorMatched: vendorId !== null,
          targetMatched: targets.length > 0,
          // Anything but 'pass' here is enough on its own to withhold the draft.
          dmarc: dmarcResult(row.authResultsJson) ?? 'unreadable',
        },
        'classify-incoming-email: AI classified (no auto-stub)',
      );
    }
```

`heuristicFallback` (lines 306-377). The row type gains `authResultsJson`, the `classifyEmail` call gains `dmarcPassed`, and the log gains `dmarc`. Replace the whole function with:

```ts
async function heuristicFallback(
  row: {
    id: string;
    fromAddress: string;
    fromName: string | null;
    subject: string;
    receivedAt: Date;
    createdServiceRecordId: string | null;
    authResultsJson: Prisma.JsonValue | null;
  },
  candidates: {
    vendors: Array<{ id: string; name: string; email: string | null; notes: string | null }>;
    items: Array<{ id: string; name: string }>;
    systems: Array<{ id: string; name: string }>;
  },
  augmentedBody: string,
  ownsRow: boolean,
): Promise<void> {
  const result = classifyEmail({
    fromAddress: row.fromAddress,
    fromName: row.fromName,
    subject: row.subject,
    bodyText: augmentedBody,
    vendors: candidates.vendors,
    items: candidates.items,
    systems: candidates.systems,
    // An attacker can force this path by making the AI call fail, and its
    // vendor match trusts From: exactly. Same gate as the AI path.
    dmarcPassed: dmarcPassed(row.authResultsJson),
  });

  await prisma.$transaction(async (tx) => {
    if (ownsRow) {
      await tx.incomingEmailTarget.deleteMany({ where: { incomingEmailId: row.id } });
      if (result.targets.length > 0) {
        await tx.incomingEmailTarget.createMany({
          data: result.targets.map((t) => ({
            incomingEmailId: row.id,
            itemId: t.itemId,
            systemId: t.systemId,
          })),
        });
      }
    }
    await tx.incomingEmail.update({
      where: { id: row.id },
      data: {
        kind: result.kind,
        vendorId: result.vendorId,
        ...(ownsRow
          ? {
              state:
                result.vendorId || result.targets.length > 0
                  ? ('AUTO_LINKED' as const)
                  : ('UNTRIAGED' as const),
            }
          : {}),
      },
    });
  });

  if (result.shouldAutoStubServiceRecord && !row.createdServiceRecordId) {
    await autoStub({
      rowId: row.id,
      vendorId: result.vendorId,
      targets: result.targets,
      performedOn: startOfDayUtc(row.receivedAt, await getHouseTimezone()),
      summary: fallbackSummary(row.subject),
      notes: AUTO_NOTE,
    });
  } else {
    log.info(
      {
        id: row.id,
        kind: result.kind,
        vendorMatched: result.vendorId !== null,
        dmarc: dmarcResult(row.authResultsJson) ?? 'unreadable',
      },
      'classify-incoming-email: heuristic classified (no auto-stub)',
    );
  }
}
```

(`Prisma` is already imported as `import type { Prisma } from '@prisma/client';` on line 1. `Prisma.JsonValue` is a type, so the type-only import is enough. The call `heuristicFallback(row, …)` on line 241 needs no change: `row` now carries `authResultsJson`.)

- [ ] **Step 8: Run everything touched and watch it pass**

```bash
pnpm exec vitest run lib/incoming-email
pnpm exec vitest run tests/integration/incoming-email-classify-job.test.ts
pnpm typecheck
pnpm lint:worker-graph
pnpm exec tsx --env-file=.env -e "import('@/worker/jobs/classify-incoming-email').then(() => console.log('ok'))"
```

Expected: all PASS; typecheck clean; `lint:worker-graph` OK; the smoke import prints `ok`. Per the repo's ESM/CJS note, smoke-importing a changed worker module catches interop breakage that typecheck can't.

- [ ] **Step 9: Commit**

```bash
git add lib/incoming-email/ai-classify.ts lib/incoming-email/ai-classify.test.ts lib/incoming-email/classify.ts lib/incoming-email/classify.test.ts worker/jobs/classify-incoming-email.ts tests/integration/incoming-email-classify-job.test.ts
git commit -m "fix(inbound-email): require DMARC pass before auto-stubbing a service record"
git log --oneline -1
```

---

### Task 8: Global security headers (S-M1) and a browser-level check

**Files:**
- Modify: `next.config.ts` (lines 4-28)
- Modify: `tests/e2e/attachments.spec.ts` (append)

- [ ] **Step 1: Write the failing e2e test**

Append to `tests/e2e/attachments.spec.ts`:

```ts

// The only test that sees the headers a BROWSER gets. next.config.ts
// `headers()` are applied before a route handler runs and WIN on a name clash
// (Next drops the handler's value), so a global CSP would silently replace
// the file route's sandbox. Integration tests call handlers directly and
// can't see that. @critical because nothing else would notice the regression.
test('pages and files carry their security headers @critical', async ({ page, context }) => {
  await context.clearCookies();
  await signIn(page);

  const pageResponse = await page.goto('/items/new');
  expect(pageResponse).not.toBeNull();
  const pageHeaders = (await pageResponse?.allHeaders()) ?? {};
  expect(pageHeaders['x-frame-options']).toBe('DENY');
  expect(pageHeaders['content-security-policy']).toBe("frame-ancestors 'none'");
  expect(pageHeaders['x-content-type-options']).toBe('nosniff');
  expect(pageHeaders['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(pageHeaders['strict-transport-security']).toBe('max-age=86400');
  expect(pageHeaders['x-powered-by']).toBeUndefined();

  // A real PDF, uploaded the normal way, then fetched as the browser would.
  await page.getByLabel('Name').fill('Water Heater');
  await page.getByRole('combobox', { name: 'Category' }).click();
  await page.getByRole('option', { name: /HVAC/i }).click();
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(page).toHaveURL(/\/items\/c[a-z0-9]+\/suggest-after-create$/);
  await page.getByRole('button', { name: 'Skip' }).click();
  await expect(page).toHaveURL(/\/items\/c[a-z0-9]+$/);
  await page.getByRole('link', { name: 'Files' }).click();
  await page.setInputFiles('input[type=file]', 'tests/fixtures/sample.pdf');
  const fileLink = page.locator('a[href^="/api/files/"]').first();
  await expect(fileLink).toBeVisible({ timeout: 10_000 });
  const href = await fileLink.getAttribute('href');
  expect(href).toBeTruthy();

  const fileResponse = await page.request.get(href as string);
  expect(fileResponse.status()).toBe(200);
  const fileHeaders = fileResponse.headers();
  expect(fileHeaders['content-type']).toBe('application/pdf');
  expect(fileHeaders['content-disposition']).toMatch(/^inline;/);
  expect(fileHeaders['x-content-type-options']).toBe('nosniff');
  // The route's own policy, NOT the global frame-ancestors one.
  expect(fileHeaders['content-security-policy']).toBe(
    "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  );
  expect(fileHeaders['x-frame-options']).toBeUndefined();
  expect(fileHeaders['x-powered-by']).toBeUndefined();
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm test:e2e:local tests/e2e/attachments.spec.ts
```

Expected: FAIL on the first page-header assertion: `expected undefined to be 'DENY'`.

- [ ] **Step 3: Implement**

In `next.config.ts`, add these constants above `const nextConfig` (after the imports, line 3):

```ts

// Headers for every response. None clashes with a route's own header except
// X-Content-Type-Options on /api/files, where both values are `nosniff`.
const SECURITY_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Prod is only reached over TLS (behind the reverse proxy; Authelia OIDC
  // requires it). Browsers ignore HSTS on plain-http responses, so `pnpm dev`
  // on http://localhost is unaffected. Deliberately short: on a self-hosted
  // site, HSTS turns a lapsed cert into a lockout with no click-through. One
  // day, no includeSubDomains, no preload. Raise it (e.g. to a year) once TLS
  // has been confirmed stable.
  { key: 'Strict-Transport-Security', value: 'max-age=86400' },
];

// Anti-framing for pages. Scoped AWAY from /api/files/: Next applies these
// before a route handler runs and then DROPS any handler header with the same
// name (node_modules/next/dist/server/send-response.js), so a global
// Content-Security-Policy here would replace the file route's sandbox CSP
// (lib/attachments/serve.ts) outright. Files need no framing protection: a
// sandboxed download or image has nothing to clickjack.
//
// No script-src CSP, deliberately: with RSC it needs per-request nonces from
// a proxy.ts, and a proxy.ts truncates request bodies over 10 MB
// (proxyClientMaxBodySize), which would break HMAC on large inbound emails.
const FRAME_HEADERS = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
];
```

and inside `nextConfig`, after the `allowedDevOrigins` property (line 27), add:

```ts
  // Don't advertise the framework on every response.
  poweredByHeader: false,
  async headers() {
    return [
      { source: '/:path*', headers: SECURITY_HEADERS },
      // Everything except /api/files/<id>. Pattern checked with Next's own
      // matcher: matches /, /items/x, /api/health, /_next/...; not /api/files/x.
      { source: '/((?!api/files/).*)', headers: FRAME_HEADERS },
    ];
  },
```

- [ ] **Step 4: Run it and watch it pass, then eyeball the real headers**

```bash
pnpm test:e2e:local tests/e2e/attachments.spec.ts
pnpm typecheck
```

Expected: both tests in the file PASS; typecheck clean.

With `pnpm dev` running:

```bash
curl -sI http://localhost:3000/api/health
```

Expected: `x-frame-options: DENY`, `content-security-policy: frame-ancestors 'none'`, `x-content-type-options: nosniff`, `referrer-policy: strict-origin-when-cross-origin`, `strict-transport-security: max-age=86400`, and **no** `x-powered-by`.

- [ ] **Step 5: Commit**

```bash
git add next.config.ts tests/e2e/attachments.spec.ts
git commit -m "fix(security): add global security headers and drop X-Powered-By"
git log --oneline -1
```

---

### Task 9: Document the trust model

**Files:**
- Modify: `CLAUDE.md` (insert a new "Rules that bite" subsection after line 327, the end of "`app/(app)/` is the only auth boundary")

- [ ] **Step 1: Add the section**

Insert between the paragraph ending `` `inbound-email/[token]` routes are deliberately public.`` and `### Migrations carry SQL that Prisma cannot regenerate`:

```markdown
### Inbound email is hostile input; the file route is the XSS boundary

The webhook's token + HMAC authenticate **ForwardEmail**, not the sender. Whoever
knows the inbox address controls the body, every attachment's bytes, filename and
declared `Content-Type`, and can forge `From:`.

- **`/api/files/[id]` decides what renders** (`lib/attachments/serve.ts`): a
  raster/PDF allow-list inline, everything else an `application/octet-stream`
  download, always `nosniff` + a `sandbox` CSP. It reads the stored type at
  *serve* time, which is what covers rows ingested before types were sniffed.
  Never serve a stored file any other way.
- **Ingest trusts neither the declared type nor the name**
  (`lib/incoming-email/normalize-attachment.ts`): magic-byte sniff to an
  allow-listed type or octet-stream; on-disk name always `original.<ext>`.
- **Auto-stub needs a DMARC pass** (`lib/incoming-email/auth-results.ts`), read
  fail-closed from mailauth's `dmarc.status.result` in `authResultsJson`. It
  gates *both* the AI and the heuristic path. Every other input is a model output
  the email can steer. A vendor with no DMARC record never auto-stubs, by design.
  DMARC proves the From *domain*, not that it is the vendor's.
- **A `next.config.ts` `headers()` entry beats a route handler's header of the
  same name.** Next writes config headers first and drops the handler's
  (`send-response.js`), which is why the global CSP skips `/api/files/`. No
  script-src CSP: it needs nonces from a `proxy.ts`, and a proxy truncates
  bodies over 10 MB, which breaks inbound HMAC.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document the inbound-email trust model and headers() precedence"
git log --oneline -1
```

---

### Task 10: Full verification (implementer runs 1-4; the USER runs 5-7)

- [ ] **Step 1: The gate**

```bash
pnpm verify
```

Expected: Biome, `lint:tokens`, `lint:worker-graph` and `lint:knip` pass; `tsc --noEmit` clean; all unit tests pass. If knip flags an export, check it is one this plan added: every new export has a production consumer (`fileResponseHeaders` → file route; `OCTET_STREAM`/`sniffAllowedMime` → normalizer/serve; `normalizeInboundAttachment` → ingest; `dmarcPassed`/`dmarcResult` → worker). Never silence knip with an ignore entry for these.

- [ ] **Step 2: Every touched integration file, one at a time** (Docker running)

```bash
pnpm exec vitest run tests/integration/file-route-security.test.ts
pnpm exec vitest run tests/integration/inbound-email-webhook.test.ts
pnpm exec vitest run tests/integration/incoming-email-classify-job.test.ts
pnpm exec vitest run tests/integration/incoming-email-actions.test.ts
```

Expected: PASS. The last file is untouched and is a regression check on the button path through `createServiceRecordForEmail`, which is not DMARC-gated by design: a human clicked it.

- [ ] **Step 3: The full pre-merge umbrella**

```bash
pnpm test:local
```

Expected: unit → integration → full e2e → coverage floor all green. **Never lower a threshold in `vitest.config.ts`.** The new `lib/` files all ship with tests, so the floor should rise.

- [ ] **Step 4: Confirm nothing but this plan's files changed**

```bash
git status --short
git diff main --stat
```

Expected: a clean tree. The diff lists only the files in the File structure table (plus the plan copy added in Task 11). `next dev` may re-add its agent block to `CLAUDE.md` (see the note at the bottom of `CLAUDE.md`). If `git diff` shows that block as an uncommitted change, leave it out of your commits.

- [ ] **Step 5 (USER, manual, pre-merge): Cross-browser PDF check**

With `pnpm dev` running, sign in, open any item's Files tab, upload `tests/fixtures/sample.pdf` and `tests/fixtures/sample.jpg`, and click each card in **Chrome, Firefox and Safari**. Expected:
- The PDF renders inline in all three. (Safari needs ≥ 18.4. On older Safari it is blank, which is the accepted cost.)
- In Chrome's PDF toolbar, **Download** saves the file.
- The JPEG renders inline.

If Chrome or Firefox shows a blank page, or Chrome's Download button does nothing: first try `sandbox allow-downloads` in `FILE_CSP` (`lib/attachments/serve.ts`) for the download button. If rendering itself fails, fall back to omitting `sandbox` **for `application/pdf` only**, and keep `nosniff` and `default-src 'none'` on PDFs. A browser's PDF viewer does not run document JavaScript in our origin, and `nosniff` stops a PDF-labelled HTML file from rendering as HTML. Update the unit test's expected CSP for PDFs and record which browser/version forced it in the `FILE_CSP` comment.

- [ ] **Step 6 (USER, manual, pre-merge): See what the reverse proxy already sends**

```bash
curl -sI https://housemanager.owine.net/api/health
```

Look for `strict-transport-security`, `x-frame-options`, `content-security-policy`, `x-content-type-options` or `referrer-policy` that the proxy **already** adds. If the proxy sets any of them, the app's value will be duplicated after deploy. A conflicting pair, such as `X-Frame-Options: SAMEORIGIN` plus `DENY`, is handled inconsistently by browsers. In that case drop that header from either the proxy or `next.config.ts` before merge. **If the proxy already sends `Strict-Transport-Security`, drop ours** (remove it from `SECURITY_HEADERS` in `next.config.ts` and from the e2e assertion), so the browser never sees two conflicting `max-age` values.

- [ ] **Step 7 (USER, manual, pre-merge): Confirm the DMARC parser against real stored data (read-only)**

This checks `dmarc.status.result` against what ForwardEmail actually stored, and shows which senders will stop auto-stubbing. Four plain `SELECT`s, no transaction. `PGOPTIONS=-c default_transaction_read_only=on` is a session setting and only a guard: it makes an accidental write fail. It is not a `BEGIN`.

**Placeholders to confirm first.** The prod compose lives in `/opt/compose` on `piwine`, not in this repo. Take the names from there (e.g. `docker ps --format '{{.Names}}'` on `piwine`):
- `<pg-container>`: believed to be `housemanager-postgres`
- `<db-user>`: believed to be `housemanager`
- `<db-name>`: believed to be `housemanager`

The primary path needs **no password**: `psql` inside the container connects over the local Unix socket, which the official postgres image trusts. The whole remote command is single-quoted, so nothing expands locally, and the SQL travels on stdin:

```bash
ssh piwine 'docker exec -i -e PGOPTIONS="-c default_transaction_read_only=on" <pg-container> psql -v ON_ERROR_STOP=1 -U <db-user> -d <db-name> -P pager=off' <<'SQL'
-- 1. The real stored shape for the last 10 inbound emails.
SELECT id,
       "receivedAt",
       "fromAddress",
       jsonb_typeof("authResultsJson"->'dmarc')          AS dmarc_type,
       "authResultsJson"->'dmarc'->'status'->>'result'   AS dmarc_status_result,
       left(("authResultsJson"->'dmarc')::text, 300)     AS dmarc_raw
FROM incoming_emails
ORDER BY "receivedAt" DESC
LIMIT 10;

-- 2. How the gate splits ALL historical mail. '<unreadable>' = would never auto-stub.
SELECT coalesce("authResultsJson"->'dmarc'->'status'->>'result', '<unreadable>') AS dmarc,
       count(*)
FROM incoming_emails
GROUP BY 1
ORDER BY 2 DESC;

-- 3. Senders whose mail became a service record (button OR auto-stub; the two
--    can't be told apart) and the DMARC verdict each would now get.
SELECT "fromAddress",
       "authResultsJson"->'dmarc'->'status'->>'result' AS dmarc,
       count(*)
FROM incoming_emails
WHERE "createdServiceRecordId" IS NOT NULL
GROUP BY 1, 2
ORDER BY 3 DESC;

-- 4. Inbound attachment types already stored. Anything outside
--    jpeg/png/webp/heic/pdf is now served as a download.
SELECT "mimeType", count(*)
FROM attachments
WHERE "incomingEmailId" IS NOT NULL
GROUP BY 1
ORDER BY 2 DESC;
SQL
```

If it fails with a password or authentication error (the socket is not trusted in this deployment), **don't put the password on any command line**. A `${VAR}` inside a double-quoted `ssh` string expands locally, before `op run` injects it, and would land in the remote process's argv, visible in `ps`. Instead, open an interactive session and type the password at psql's own prompt (`-W`). Then paste the four queries:

```bash
ssh -t piwine 'docker exec -it -e PGOPTIONS="-c default_transaction_read_only=on" <pg-container> psql -v ON_ERROR_STOP=1 -U <db-user> -d <db-name> -W -P pager=off'
```

Take the password from 1Password (`op://Docker/piwine-housemanager/db_password`). Don't source `/opt/compose/compose.env`.

What to look for:
- **Query 1:** `dmarc_type` should be `object`, and `dmarc_status_result` should be populated (`pass`/`fail`/`none`) for recent mail. If `dmarc_status_result` is NULL while `dmarc_raw` shows a verdict somewhere else, **stop and do not merge**: the parser's path is wrong for this deployment, and the gate would silently disable all auto-stubbing.
- **Queries 2-3:** vendors that currently auto-stub but show `none`/`fail` will now land in triage instead. That is expected; decide whether it's acceptable before merging.
- **Query 4:** anything like `text/html`, `image/svg+xml` or `*javascript*` means a hostile or odd attachment was already received. It is neutralized by this change with no migration. Consider telling the user which email it came from.

---

### Task 11: PR

- [ ] **Step 1: Commit this plan into the repo**

```bash
cp .full-review/plans/2026-09-24-inbound-email-security.md docs/superpowers/plans/2026-09-24-inbound-email-security.md
git add docs/superpowers/plans/2026-09-24-inbound-email-security.md
git commit -m "docs: add inbound email security plan"
git log --oneline -1
```

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin fix/inbound-email-security
gh pr create --title "fix(security): close the inbound-email stored-XSS chain" --body "$(cat <<'EOF'
Closes review findings S-H1, S-H2, S-M1, A-H1, A-H2.

- **File route is the XSS boundary** (`lib/attachments/serve.ts`): only jpeg/png/webp/heic/pdf render inline; everything else is an `application/octet-stream` download. Always `nosniff` + `default-src 'none'; style-src 'unsafe-inline'; sandbox`. Decided at serve time, so existing rows are neutralized with no migration.
- **Ingest sniffs bytes** (reuses `file-type`), stores `original.<ext>`, generates a name for missing/`.`/`..` filenames. That fixes the `Attachment_file_metadata_required` CHECK 500 → ForwardEmail retry loop. Failed ingests now remove the files they wrote.
- **Auto-stub requires DMARC pass**, read fail-closed from mailauth's `dmarc.status.result`. Gates both the AI path and the heuristic fallback.
- **Global headers**: nosniff, Referrer-Policy, HSTS (`max-age=86400` to start: no includeSubDomains, no preload; raise once TLS is confirmed stable), XFO DENY + `frame-ancestors 'none'` (scoped away from `/api/files/`, because `next.config` headers override route headers), `poweredByHeader: false`. No script-src CSP (needs a proxy.ts nonce; a proxy truncates >10 MB webhook bodies).

**Accepted tradeoff: byte-sniffing narrows some real attachments.** Anything `file-type` doesn't map to jpeg/png/webp/heic/pdf is now stored as `application/octet-stream`. It is served as a download and drops out of the `mimeType: 'application/pdf'` filter that feeds PDFs to the classifier. Known real-world cases:
- non-`heic` HEIF brands (e.g. `mif1` → `image/heif`);
- PDFs with junk bytes before `%PDF` (the spec tolerates them; `file-type` only checks offset 0).

These are rare, still downloadable, and far cheaper than trusting the sender's type.

**Remaining S-H2 gap (follow-up, not in this PR).** DMARC pass proves only that the sender controls the `From:` domain. An attacker sending from their own DMARC-passing domain, with a body naming a real vendor, can still steer the model into auto-stubbing a record against that vendor. XSS is closed regardless (the file route), but fabricated records and RAG injection are not. The fix is to also require the sender's domain to match the matched vendor's `Vendor.email` domain.

Plan: `docs/superpowers/plans/2026-09-24-inbound-email-security.md`.

Pre-merge manual checks (plan Task 10 steps 5-7): cross-browser PDF render, reverse-proxy header overlap, read-only prod SELECT of stored DMARC shape.
EOF
)"
```

- [ ] **Step 3: Gate on Sourcery (background)**

Poll **only** the `Sourcery review` check, in the background (`run_in_background: true`):

```bash
PR=$(gh pr view --json number -q .number)
for i in $(seq 1 40); do
  state=$(gh pr checks "$PR" --json name,state -q '.[] | select(.name=="Sourcery review") | .state')
  case "$state" in SUCCESS|FAILURE|NEUTRAL|SKIPPED|CANCELLED) echo "sourcery: $state"; break;; esac
  sleep 30
done
echo "final: ${state:-never started}"
```

When it finishes, read the review. The check's pass/skip status says nothing about whether Sourcery hit a limit, so read the bodies:

```bash
gh api repos/owine/house-manager/pulls/$PR/reviews -q '.[] | select(.user.login|test("sourcery";"i")) | .body'
gh api repos/owine/house-manager/pulls/$PR/comments -q '.[] | select(.user.login|test("sourcery";"i")) | "\(.path):\(.line) \(.body)"'
```

Address actionable comments with superpowers:receiving-code-review: verify each one before changing code, then commit (explicit paths), push, and verify HEAD moved. If Sourcery never starts, don't wait on it.

- [ ] **Step 4: Enable auto-merge, then watch CI (background)**

```bash
gh pr merge "$PR" --auto --squash
gh pr checks "$PR" --watch --fail-fast   # run_in_background: true
```

If a check fails, diagnose, push a fix, and leave auto-merge armed. When CI is green and the PR merges:

```bash
gh pr view "$PR" --json state,mergedAt -q '{state,mergedAt}'   # expect MERGED
git checkout main && git pull --ff-only && git branch -d fix/inbound-email-security
```

---

## Acceptance criteria

- [ ] An inbound attachment declared `text/html` or `image/svg+xml` is stored as `application/octet-stream` and served as `attachment` with `nosniff` and the sandbox CSP (integration-tested).
- [ ] A pre-existing row carrying `text/html` is served the same way with no data change (integration-tested).
- [ ] A real PDF/JPEG still serves inline (integration + e2e tested); PDFs render in Chrome, Firefox and Safari ≥ 18.4 (manual).
- [ ] An attachment with a null/absent filename or content type, or a filename of `..`, ingests with 200 (no CHECK violation); a failed ingest leaves no files behind (integration-tested).
- [ ] DMARC `fail`, missing, or non-mailauth-shaped → no service record from either the AI or heuristic path; DMARC `pass` → auto-stub as before (integration-tested).
- [ ] Pages carry XFO/`frame-ancestors`/nosniff/Referrer-Policy/HSTS and no `X-Powered-By`; `/api/files/*` carries its own CSP, not the global one (e2e `@critical`).
- [ ] The read-only prod query confirms `authResultsJson.dmarc.status.result` is populated in real data.
- [ ] `pnpm verify` and `pnpm test:local` pass; coverage floor met or raised.

## Deliberately out of scope

- **A script-restricting CSP.** It needs per-request nonces from a `proxy.ts` (plus a hash for the inline theme script in `app/layout.tsx`), and a proxy truncates inbound bodies over 10 MB. That needs its own design (e.g. a `matcher` that excludes `/api/inbound-email`).
- **Sender-domain ↔ vendor-domain matching (the remaining S-H2 gap, also stated in the PR body).** DMARC pass proves only that the sender controls the `From:` domain. An attacker sending from **their own** DMARC-passing domain, with a body naming a real vendor, can still steer the AI to that vendor and auto-stub a record. The XSS half is closed by the file route regardless; the fabricated-record/RAG half is not. The review's recommended extra check, `domainOf(fromAddress) === domainOf(vendor.email)`, is the natural follow-up. It was not part of the decided scope; raise it with the user.
- Per-sender rate limiting / `INBOUND_ALLOWED_SENDERS`, prompt hardening, and holding auto-stubbed records out of the embedding index until a human confirms (review S-H2 extras).
- Restricting which attachments `createServiceRecordForEmail` re-parents. With serve-time enforcement a re-parented non-allow-listed file is a harmless download.
- `AttachmentCard` shows a broken thumbnail for a legacy row whose stored type is a non-allow-listed `image/*` (e.g. `image/svg+xml`, `image/gif`), because the `<img>` now gets octet-stream + `nosniff`. That is cosmetic, and Task 10 query 4 shows whether any such row exists.
- Thumbnails / OCR / embeddings for inbound attachments (the second half of A-H2), request-body buffering before the size check (S-M3), and a data migration for legacy rows (not needed).
