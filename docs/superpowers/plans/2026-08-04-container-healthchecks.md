# Container Healthchecks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give both the web and worker containers an honest, DB-backed health signal so a hung or dependency-starved container reports `unhealthy` instead of looking fine.

**Architecture:** One shared health contract in `lib/health.ts` (Postgres fatal, Meilisearch reported-but-not-fatal) consumed by two callers: web's existing `/api/health` route, and a new minimal `node:http` server in the worker that serves the *same path on the same port*. Because containers get separate network namespaces, a single `HEALTHCHECK` line in the Dockerfile is then correct for both roles — no role detection, no env var, no change to the production GitOps compose.

**Tech Stack:** TypeScript, `node:http`, `pg`, pg-boss 12, Vitest, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-08-04-container-healthchecks-design.md`

---

## Background the implementer needs

**Why this exists.** On 2026-07-30 the worker crash-looped for five days (792 restarts) and nothing noticed, because the worker had no health signal and web's `/api/health` returned 200 unconditionally.

**A HEALTHCHECK does not catch a crash-loop.** Docker only probes *running* containers. This work catches a **hung-but-alive** worker. It helps with crash-loops only insofar as the container never reaches `healthy` — the alerting side is out of scope and lives in uptime-kuma.

**pg-boss version gotcha.** This repo is on **pg-boss 12.26.3**. `getQueueSize()` does **not** exist. Use `getQueue(name)`, which returns `Promise<QueueResult | null>`.

**Calendar dates / timezones are not involved here.** Every timestamp in this feature is an instant compared against another instant. Do not reach for `lib/time/tz.ts`.

**Repo conventions that apply:**
- `pnpm`, never `npx`/`npm`.
- Colocated tests: `lib/**/*.test.ts` and `worker/**/*.test.ts` are both in the Vitest unit include *and* the coverage include (`vitest.config.ts:18-47`).
- Never `--no-verify`. `git commit` can fail silently behind the Biome pre-commit hook — **verify `HEAD` actually moved** after each commit.
- Run `pnpm verify` before pushing.

## File structure

| File | Responsibility |
|---|---|
| `lib/health.ts` *(modify)* | The two dependency probes plus the two contracts built on them (`isReady` strict, `checkHealth` DB-fatal-only). Shared by web and worker. |
| `lib/health.test.ts` *(create)* | Unit tests for the probes and both contracts, with `pg` and `fetch` mocked. |
| `app/api/health/route.ts` *(modify)* | Web's liveness endpoint, now DB-backed. |
| `worker/heartbeat.ts` *(create)* | Pure heartbeat state machine — interval, freshness, age. No HTTP, no pg-boss import. Injectable clock and probe. |
| `worker/heartbeat.test.ts` *(create)* | Unit tests for freshness transitions and interval behaviour. |
| `worker/health-server.ts` *(create)* | `node:http` server + status resolution. Takes a heartbeat and a deps-check as parameters. |
| `worker/health-server.test.ts` *(create)* | Unit tests for status resolution and HTTP behaviour against an ephemeral port. |
| `worker/index.ts` *(modify)* | Wiring only: start server → start boss → first beat → start interval; stop on shutdown. |
| `Dockerfile` *(modify)* | The `HEALTHCHECK` instruction, replacing the comment at lines 130-132. |
| `docker-compose.yml` *(modify)* | Drop web's now-redundant override; drop the worker's "no healthcheck" comment. |
| `tests/integration/health.test.ts` *(modify)* | Add `checkHealth` coverage against the real Testcontainers stack. |
| `docs/README.md` *(modify)* | Line 36 describes `/api/health` as liveness. |

Splitting `heartbeat` from `health-server` is deliberate: the staleness logic is the part with real edge cases, and isolating it means testing it needs neither a socket nor a running pg-boss.

---

### Task 1: Shared health contract in `lib/health.ts`

**Files:**
- Modify: `lib/health.ts`
- Test: `lib/health.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `lib/health.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const connect = vi.fn();
const query = vi.fn();
const end = vi.fn();

vi.mock('pg', () => ({
  Client: class {
    connect = connect;
    query = query;
    end = end;
  },
}));

import { checkHealth, isReady } from './health';

const OPTS = { databaseUrl: 'postgresql://x/y', meiliUrl: 'http://meili:7700' };

beforeEach(() => {
  connect.mockReset().mockResolvedValue(undefined);
  query.mockReset().mockResolvedValue({ rows: [] });
  end.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('checkHealth', () => {
  it('is ok when both dependencies answer', async () => {
    const result = await checkHealth(OPTS);
    expect(result.status).toBe('ok');
    expect(result.checks).toEqual({ database: 'ok', meilisearch: 'ok' });
  });

  it('is down when the database is unreachable', async () => {
    connect.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await checkHealth(OPTS);
    expect(result.status).toBe('down');
    expect(result.checks.database).toContain('ECONNREFUSED');
  });

  // The whole point of this contract: search degrades, it does not page.
  it('stays ok when meilisearch is unreachable, but reports it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const result = await checkHealth(OPTS);
    expect(result.status).toBe('ok');
    expect(result.checks.database).toBe('ok');
    expect(result.checks.meilisearch).toContain('ECONNREFUSED');
  });

  it('reports a non-2xx meilisearch response without failing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 } as Response));
    const result = await checkHealth(OPTS);
    expect(result.status).toBe('ok');
    expect(result.checks.meilisearch).toBe('error: HTTP 503');
  });

  it('closes the connection even when the query throws', async () => {
    query.mockRejectedValue(new Error('boom'));
    await checkHealth(OPTS);
    expect(end).toHaveBeenCalledTimes(1);
  });
});

describe('isReady', () => {
  it('is ready when both dependencies answer', async () => {
    await expect(isReady(OPTS)).resolves.toMatchObject({ ready: true });
  });

  // Guards the refactor: isReady must NOT inherit checkHealth's looser contract.
  it('is not ready when meilisearch is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const result = await isReady(OPTS);
    expect(result.ready).toBe(false);
    expect(result.checks.database).toBe('ok');
  });

  it('is not ready when the database is unreachable', async () => {
    connect.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(isReady(OPTS)).resolves.toMatchObject({ ready: false });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm exec vitest run lib/health.test.ts
```

Expected: FAIL — `checkHealth` is not exported from `./health`.

- [ ] **Step 3: Write the implementation**

Replace the whole of `lib/health.ts`:

```ts
import { Client } from 'pg';

export type ReadyResult = {
  ready: boolean;
  checks: HealthChecks;
};

export type HealthChecks = { database: string; meilisearch: string };

export type HealthResult = {
  status: 'ok' | 'down';
  checks: HealthChecks;
};

const PROBE_TIMEOUT_MS = 2000;

/** Returns `'ok'`, or `'error: <message>'`. Never throws. */
export async function probeDatabase(databaseUrl: string): Promise<string> {
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: PROBE_TIMEOUT_MS,
  });
  try {
    await client.connect();
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
  try {
    await client.query('SELECT 1');
    return 'ok';
  } catch (e) {
    return `error: ${(e as Error).message}`;
  } finally {
    // Must run even when the query throws, or a failing probe leaks a
    // connection every 30 seconds for as long as the fault lasts.
    await client.end().catch(() => {});
  }
}

/** Returns `'ok'`, or `'error: <message>'`. Never throws. */
export async function probeMeilisearch(meiliUrl: string): Promise<string> {
  try {
    const res = await fetch(`${meiliUrl}/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.ok ? 'ok' : `error: HTTP ${res.status}`;
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

type ProbeOptions = { databaseUrl: string; meiliUrl: string };

// Run both probes concurrently: the Docker healthcheck allows 5s total and
// each probe is allowed 2s, so sequential probes would leave almost no margin.
async function probeAll(opts: ProbeOptions): Promise<HealthChecks> {
  const [database, meilisearch] = await Promise.all([
    probeDatabase(opts.databaseUrl),
    probeMeilisearch(opts.meiliUrl),
  ]);
  return { database, meilisearch };
}

/**
 * Strict readiness: every dependency must answer. Backs `/api/health/ready`.
 */
export async function isReady(opts: ProbeOptions): Promise<ReadyResult> {
  const checks = await probeAll(opts);
  return { ready: checks.database === 'ok' && checks.meilisearch === 'ok', checks };
}

/**
 * Container health: Postgres is fatal, Meilisearch is reported but tolerated.
 *
 * Search is eventually consistent by design — `enqueueSearchIndex` swallows
 * its errors and the nightly `search.reindex` rebuilds the index — so a
 * Meilisearch outage degrades the app rather than breaking it, and must not
 * mark a container unhealthy. Postgres is different: without it neither the
 * web app nor the worker can do anything at all.
 */
export async function checkHealth(opts: ProbeOptions): Promise<HealthResult> {
  const checks = await probeAll(opts);
  return { status: checks.database === 'ok' ? 'ok' : 'down', checks };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm exec vitest run lib/health.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/health.ts lib/health.test.ts
git commit -m "feat(health): add checkHealth contract with Meilisearch non-fatal"
git log --oneline -1   # verify HEAD moved — the pre-commit hook can fail silently
```

---

### Task 2: Web `/api/health` gets teeth

**Files:**
- Modify: `app/api/health/route.ts`
- Modify: `tests/integration/health.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the `describe` block in `tests/integration/health.test.ts`:

```ts
describe('container health check', () => {
  it('is ok when db and meilisearch reachable', async () => {
    const result = await checkHealth({
      databaseUrl: stack.databaseUrl,
      meiliUrl: stack.meiliUrl,
    });
    expect(result.status).toBe('ok');
  });

  it('is down when db is unreachable', async () => {
    const result = await checkHealth({
      databaseUrl: 'postgresql://nope:nope@127.0.0.1:1/nope',
      meiliUrl: stack.meiliUrl,
    });
    expect(result.status).toBe('down');
  });

  it('stays ok when only meilisearch is unreachable', async () => {
    const result = await checkHealth({
      databaseUrl: stack.databaseUrl,
      meiliUrl: 'http://127.0.0.1:1',
    });
    expect(result.status).toBe('ok');
    expect(result.checks.meilisearch).not.toBe('ok');
  });
});
```

Update the import at the top of that file to `import { checkHealth, isReady } from '@/lib/health';`.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm exec vitest run tests/integration/health.test.ts
```

Expected: FAIL — `checkHealth` import resolves but the file has not been rebuilt if Task 1 was skipped; otherwise these pass and only the route change below remains. If they already pass, that is fine: this task's real deliverable is the route.

- [ ] **Step 3: Write the implementation**

Replace `app/api/health/route.ts`:

```ts
import { getEnv } from '@/lib/env';
import { checkHealth } from '@/lib/health';
import { APP_GIT_SHA, APP_VERSION } from '@/lib/version';

export const dynamic = 'force-dynamic';

/**
 * Container health for the web role. Deliberately DB-backed rather than a
 * static 200: this is what the Dockerfile HEALTHCHECK probes, and a web
 * container that cannot reach Postgres is not healthy in any useful sense.
 *
 * Note this makes `/api/health` a readiness-flavoured probe rather than a
 * pure liveness one. That is safe here because Docker restarts *exited*
 * containers, not `unhealthy` ones, so a Postgres outage cannot induce a
 * restart loop. Revisit if this ever runs under an orchestrator that
 * restarts on liveness failure.
 *
 * `/api/health/ready` keeps the stricter contract where Meilisearch is fatal.
 */
export async function GET() {
  const env = getEnv();
  const result = await checkHealth({
    databaseUrl: env.DATABASE_URL,
    meiliUrl: env.MEILI_HOST,
  });
  return Response.json(
    {
      status: result.status,
      version: APP_VERSION,
      sha: APP_GIT_SHA,
      checks: result.checks,
    },
    { status: result.status === 'ok' ? 200 : 503 },
  );
}
```

- [ ] **Step 4: Run tests and typecheck**

```bash
pnpm exec vitest run tests/integration/health.test.ts
pnpm typecheck
```

Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add app/api/health/route.ts tests/integration/health.test.ts
git commit -m "feat(health): make /api/health DB-backed for the web container"
git log --oneline -1
```

---

### Task 3: Worker heartbeat

**Files:**
- Create: `worker/heartbeat.ts`
- Test: `worker/heartbeat.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `worker/heartbeat.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHeartbeat } from './heartbeat';

afterEach(() => {
  vi.useRealTimers();
});

/** Controllable clock so freshness is deterministic. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('createHeartbeat', () => {
  it('is not fresh before the first successful beat', () => {
    const hb = createHeartbeat({ probe: async () => {}, now: () => 0 });
    expect(hb.isFresh()).toBe(false);
    expect(hb.ageMs()).toBeNull();
  });

  it('is fresh immediately after a successful beat', async () => {
    const clock = fakeClock();
    const hb = createHeartbeat({ probe: async () => {}, now: clock.now });
    await hb.beat();
    expect(hb.isFresh()).toBe(true);
    expect(hb.ageMs()).toBe(0);
  });

  it('stays fresh exactly at the staleness threshold', async () => {
    const clock = fakeClock();
    const hb = createHeartbeat({ probe: async () => {}, now: clock.now, staleMs: 1000 });
    await hb.beat();
    clock.advance(1000);
    expect(hb.ageMs()).toBe(1000);
    expect(hb.isFresh()).toBe(true);
  });

  it('goes stale one millisecond past the threshold', async () => {
    const clock = fakeClock();
    const hb = createHeartbeat({ probe: async () => {}, now: clock.now, staleMs: 1000 });
    await hb.beat();
    clock.advance(1001);
    expect(hb.isFresh()).toBe(false);
  });

  // A failing probe must not refresh the timestamp — that is the entire
  // mechanism by which a hung worker eventually reports unhealthy.
  it('does not refresh the timestamp when the probe throws', async () => {
    const clock = fakeClock();
    const probe = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error('down'));
    const hb = createHeartbeat({ probe, now: clock.now, staleMs: 1000 });
    await hb.beat();
    clock.advance(900);
    await hb.beat();
    clock.advance(200);
    expect(hb.isFresh()).toBe(false);
  });

  it('swallows probe rejections rather than throwing', async () => {
    const hb = createHeartbeat({ probe: async () => { throw new Error('boom'); } });
    await expect(hb.beat()).resolves.toBeUndefined();
  });

  it('beats on the interval once started', async () => {
    vi.useFakeTimers();
    const probe = vi.fn().mockResolvedValue(undefined);
    const hb = createHeartbeat({ probe, intervalMs: 1000 });
    hb.start();
    expect(probe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2500);
    expect(probe).toHaveBeenCalledTimes(2);
    hb.stop();
  });

  it('start and stop are idempotent', async () => {
    vi.useFakeTimers();
    const probe = vi.fn().mockResolvedValue(undefined);
    const hb = createHeartbeat({ probe, intervalMs: 1000 });
    hb.start();
    hb.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(probe).toHaveBeenCalledTimes(1);
    hb.stop();
    hb.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm exec vitest run worker/heartbeat.test.ts
```

Expected: FAIL — cannot resolve `./heartbeat`.

- [ ] **Step 3: Write the implementation**

Create `worker/heartbeat.ts`:

```ts
import { getLogger } from '@/lib/logger';

const log = getLogger('worker.heartbeat');

export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_STALE_MS = 120_000;

export type Heartbeat = {
  /** Start the interval. Idempotent. */
  start: () => void;
  /** Clear the interval. Idempotent. */
  stop: () => void;
  /** Run one beat now. Never rejects. */
  beat: () => Promise<void>;
  /** Milliseconds since the last *successful* beat, or null if none yet. */
  ageMs: () => number | null;
  /** A beat has landed and it is no older than `staleMs`. */
  isFresh: () => boolean;
};

export type HeartbeatOptions = {
  /** Liveness probe. Rejecting means "not alive"; the result is ignored. */
  probe: () => Promise<unknown>;
  intervalMs?: number;
  staleMs?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
};

/**
 * Tracks whether the worker is still able to service its queue.
 *
 * Driven by an interval rather than by job completions on purpose: the ticks
 * are five minutes apart at best and an idle house can go hours without any
 * work at all, so a job-driven heartbeat would report a perfectly healthy
 * worker as stale. The interval asks the narrower question — *can this
 * process still reach the queue* — independent of whether there is work.
 */
export function createHeartbeat(opts: HeartbeatOptions): Heartbeat {
  const intervalMs = opts.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const staleMs = opts.staleMs ?? HEARTBEAT_STALE_MS;
  const now = opts.now ?? Date.now;

  let lastOkAt: number | null = null;
  let timer: NodeJS.Timeout | null = null;

  const beat = async (): Promise<void> => {
    try {
      await opts.probe();
      lastOkAt = now();
    } catch (e) {
      // Deliberately does not clear `lastOkAt`: freshness decays with time
      // rather than flipping on a single blip.
      log.warn({ err: e }, 'worker heartbeat probe failed');
    }
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void beat(), intervalMs);
      // Never hold the event loop open for the heartbeat — the worker has its
      // own lifecycle, and an un-unref'd timer turns shutdown into a hang.
      timer.unref();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    beat,
    ageMs: () => (lastOkAt === null ? null : now() - lastOkAt),
    isFresh: () => lastOkAt !== null && now() - lastOkAt <= staleMs,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm exec vitest run worker/heartbeat.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add worker/heartbeat.ts worker/heartbeat.test.ts
git commit -m "feat(worker): add queue-liveness heartbeat"
git log --oneline -1
```

---

### Task 4: Worker health server

**Files:**
- Create: `worker/health-server.ts`
- Test: `worker/health-server.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `worker/health-server.test.ts`:

```ts
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import type { HealthResult } from '@/lib/health';
import type { Heartbeat } from './heartbeat';
import { createHealthServer, resolveStatus } from './health-server';

function stubHeartbeat(over: Partial<Heartbeat> = {}): Heartbeat {
  return {
    start: () => {},
    stop: () => {},
    beat: async () => {},
    ageMs: () => 0,
    isFresh: () => true,
    ...over,
  };
}

const OK: HealthResult = { status: 'ok', checks: { database: 'ok', meilisearch: 'ok' } };
const DOWN: HealthResult = {
  status: 'down',
  checks: { database: 'error: ECONNREFUSED', meilisearch: 'ok' },
};

describe('resolveStatus', () => {
  it('is ok when deps are ok and the heartbeat is fresh', () => {
    expect(resolveStatus(true, 0, true)).toBe('ok');
  });

  it('is starting before the first beat', () => {
    expect(resolveStatus(true, null, false)).toBe('starting');
  });

  it('is stale when a beat landed but has aged out', () => {
    expect(resolveStatus(true, 999_999, false)).toBe('stale');
  });

  // Dependency failure outranks "starting": when Postgres is gone the
  // heartbeat cannot beat either, and `down` is the more useful report.
  it('is down when deps fail, even before the first beat', () => {
    expect(resolveStatus(false, null, false)).toBe('down');
  });
});

let close: (() => Promise<void>) | null = null;

afterEach(async () => {
  await close?.();
  close = null;
});

async function serve(heartbeat: Heartbeat, deps: HealthResult) {
  const server = createHealthServer({ heartbeat, checkDeps: async () => deps });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

describe('createHealthServer', () => {
  it('answers 200 on /api/health when healthy', async () => {
    const base = await serve(stubHeartbeat(), OK);
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      status: 'ok',
      checks: { database: 'ok' },
    });
  });

  it('answers 503 when the heartbeat is stale', async () => {
    const base = await serve(stubHeartbeat({ isFresh: () => false, ageMs: () => 500_000 }), OK);
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ status: 'stale' });
  });

  it('answers 503 when a dependency is down', async () => {
    const base = await serve(stubHeartbeat(), DOWN);
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ status: 'down' });
  });

  it('404s any other path', async () => {
    const base = await serve(stubHeartbeat(), OK);
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/metrics`)).status).toBe(404);
  });

  it('ignores the query string when matching the path', async () => {
    const base = await serve(stubHeartbeat(), OK);
    expect((await fetch(`${base}/api/health?verbose=1`)).status).toBe(200);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm exec vitest run worker/health-server.test.ts
```

Expected: FAIL — cannot resolve `./health-server`.

- [ ] **Step 3: Write the implementation**

Create `worker/health-server.ts`:

```ts
import { createServer, type Server } from 'node:http';

import type { HealthResult } from '@/lib/health';
import { getLogger } from '@/lib/logger';
import type { Heartbeat } from './heartbeat';

const log = getLogger('worker.health');

/**
 * The worker deliberately serves the same port and path as the web app.
 * Containers get separate network namespaces, so there is no collision, and
 * it lets one HEALTHCHECK line in the Dockerfile be correct for both roles
 * without role detection or an extra env var.
 */
export const WORKER_HEALTH_PORT = 3000;
export const WORKER_HEALTH_PATH = '/api/health';

export type WorkerHealthStatus = 'ok' | 'starting' | 'stale' | 'down';

export function resolveStatus(
  depsOk: boolean,
  ageMs: number | null,
  fresh: boolean,
): WorkerHealthStatus {
  if (!depsOk) return 'down';
  if (ageMs === null) return 'starting';
  if (!fresh) return 'stale';
  return 'ok';
}

export type HealthServerOptions = {
  heartbeat: Heartbeat;
  checkDeps: () => Promise<HealthResult>;
};

export function createHealthServer(opts: HealthServerOptions): Server {
  return createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];

    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (path !== WORKER_HEALTH_PATH) {
      send(404, { status: 'not_found' });
      return;
    }

    void opts
      .checkDeps()
      .then((deps) => {
        const ageMs = opts.heartbeat.ageMs();
        const status = resolveStatus(deps.status === 'ok', ageMs, opts.heartbeat.isFresh());
        send(status === 'ok' ? 200 : 503, {
          status,
          role: 'worker',
          checks: deps.checks,
          heartbeat: { ageMs },
        });
      })
      .catch((e) => {
        log.error({ err: e }, 'health request failed');
        send(503, { status: 'down', role: 'worker', error: (e as Error).message });
      });
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm exec vitest run worker/health-server.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add worker/health-server.ts worker/health-server.test.ts
git commit -m "feat(worker): add health server on the web port and path"
git log --oneline -1
```

---

### Task 5: Wire the health server into the worker

**Files:**
- Modify: `worker/index.ts`

No new test — this is wiring over units already covered. It is verified by the smoke check in Step 3.

- [ ] **Step 1: Add imports**

In `worker/index.ts`, add to the `@/lib` import group (Sentry must remain the very first import — see CLAUDE.md):

```ts
import { getEnv } from '@/lib/env';
import { checkHealth } from '@/lib/health';
```

and to the relative import group:

```ts
import { createHealthServer, WORKER_HEALTH_PORT } from './health-server';
import { createHeartbeat } from './heartbeat';
```

- [ ] **Step 2: Start the server before pg-boss**

`main()` currently opens with `const boss = await getBoss();`. Insert **above** that line:

```ts
  // Start the health server before pg-boss so that a worker wedged connecting
  // to Postgres reports unhealthy rather than being unprobeable. Until the
  // first successful beat it answers 503 `starting`.
  const env = getEnv();
  const heartbeat = createHeartbeat({
    // pg-boss 12 has no getQueueSize; getQueue is DB-backed and proves both
    // that the connection works and that the schema is intact.
    probe: async () => {
      const b = await getBoss();
      await b.getQueue(Queue.Notify);
    },
  });
  const healthServer = createHealthServer({
    heartbeat,
    checkDeps: () => checkHealth({ databaseUrl: env.DATABASE_URL, meiliUrl: env.MEILI_HOST }),
  });
  healthServer.listen(WORKER_HEALTH_PORT, () => {
    logger.info({ port: WORKER_HEALTH_PORT }, 'worker health server listening');
  });
```

- [ ] **Step 3: Start the heartbeat after registration**

Immediately after the existing `startMemoryWatchdog({ thresholdMb: 800, intervalMs: 60_000 });` line, add:

```ts
  // First beat now so the container can go healthy without waiting a full
  // interval; the interval keeps it fresh thereafter.
  await heartbeat.beat();
  heartbeat.start();
```

- [ ] **Step 4: Stop both on shutdown**

In the existing `shutdown` function, before `await boss.stop({ graceful: true });`, add:

```ts
    heartbeat.stop();
    healthServer.close();
```

- [ ] **Step 5: Verify it typechecks and imports cleanly**

```bash
pnpm typecheck
pnpm lint:worker-graph
pnpm exec tsx -e "import('./worker/health-server.ts').then(() => console.log('ok'))"
```

Expected: typecheck clean; `lint:worker-graph` reports OK with a higher module count; the import smoke test prints `ok`. (Per CLAUDE.md, smoke-testing new worker module imports catches ESM/CJS interop breakage that typecheck cannot see.)

- [ ] **Step 6: Verify against a real stack**

```bash
docker compose up -d db meilisearch
pnpm worker:dev
```

In a second terminal:

```bash
curl -isS http://localhost:3000/api/health | head -20
```

Expected: `HTTP/1.1 200 OK` with `"status":"ok"`, `"role":"worker"` and a small `heartbeat.ageMs`. Then stop the db (`docker compose stop db`), wait ~10s, and re-curl: expect `503` with `"status":"down"`. Restart the db afterwards.

- [ ] **Step 7: Commit**

```bash
git add worker/index.ts
git commit -m "feat(worker): serve health on port 3000 and beat the queue probe"
git log --oneline -1
```

---

### Task 6: Dockerfile and compose

**Files:**
- Modify: `Dockerfile:130-132`
- Modify: `docker-compose.yml:72-77` and `:91-92`

- [ ] **Step 1: Add the HEALTHCHECK**

In `Dockerfile`, replace these three lines:

```dockerfile
# Healthcheck is defined per-service in docker-compose.yml (web only).
# This image is used by both web and worker; the worker has no HTTP surface
# so it doesn't get a healthcheck.
```

with:

```dockerfile
# One healthcheck serves both roles: web answers /api/health from Next.js and
# the worker answers the identical path from worker/health-server.ts. Both
# bind 3000, which does not collide because each container has its own network
# namespace, and compose publishes only web's.
#
# start-period covers web's `db:deploy && db:seed` on boot; failures inside it
# do not count toward retries.
#
# NOTE: this cannot detect a container that crashes during boot — Docker only
# probes running containers. Such a container never leaves `starting`, so the
# monitor consuming this must treat *anything but healthy* as down.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD curl -fsS http://localhost:3000/api/health || exit 1
```

- [ ] **Step 2: Simplify compose**

In `docker-compose.yml`, delete web's now-redundant override (lines 72-77):

```yaml
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:3000/api/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 120s
```

and replace the worker's comment (lines 91-92):

```yaml
    # No healthcheck: the worker is a long-running process with no HTTP surface.
    # docker auto-restarts on crash via restart: unless-stopped.
```

with:

```yaml
    # Healthcheck comes from the image (see Dockerfile). The worker serves the
    # same /api/health path as web from its own health server.
```

- [ ] **Step 3: Verify end to end**

```bash
docker compose up -d --build
sleep 150
docker compose ps
```

Expected: **both** `web` and `worker` show `(healthy)`. This is the acceptance criterion for the whole plan.

```bash
docker compose exec worker curl -fsS http://localhost:3000/api/health
```

Expected: JSON with `"role":"worker"`.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile docker-compose.yml
git commit -m "feat(docker): add HEALTHCHECK covering both web and worker"
git log --oneline -1
```

---

### Task 7: Docs

**Files:**
- Modify: `docs/README.md:36`

- [ ] **Step 1: Update the health endpoint description**

Replace line 36:

```markdown
Health endpoints (web): `/api/health` (liveness), `/api/health/ready` (db + meilisearch reachable).
```

with:

```markdown
Health endpoints: `/api/health` (container health — Postgres fatal, Meilisearch
reported but tolerated; served by *both* web and the worker on port 3000) and
`/api/health/ready` (web only; strict — db *and* meilisearch must answer).
The Dockerfile `HEALTHCHECK` probes `/api/health`. Note Docker only probes
running containers, so a container that crash-loops at boot never reports
`unhealthy` — it stays `starting`. Alerting must treat anything other than
`healthy` as down.
```

- [ ] **Step 2: Commit**

```bash
git add docs/README.md
git commit -m "docs: describe the container health contract"
git log --oneline -1
```

---

### Task 8: Full verification and PR

- [ ] **Step 1: Run the full gate**

```bash
pnpm verify
```

Expected: biome, `lint:tokens`, `lint:worker-graph`, `lint:knip` all pass; `tsc --noEmit` clean; all unit tests pass.

- [ ] **Step 2: Confirm coverage did not regress**

```bash
pnpm test:local
```

Expected: coverage floor met. The new files are all in `coverage.include` (`lib/**`, `worker/**`) and all ship with tests, so this should move the floor *up*, never down. **Never lower a threshold in `vitest.config.ts` to make this pass.**

- [ ] **Step 3: Open the PR**

```bash
git push -u origin feat/container-healthchecks
gh pr create --title "feat: container healthchecks for web and worker" --body "<summary + link to spec>"
```

Then per repo convention: watch the `Sourcery review` check, address any comments, enable auto-merge (`gh pr merge --auto --squash`), and watch CI.

---

## Acceptance criteria

- [ ] `docker compose up -d --build` ends with **both** web and worker reporting `(healthy)`.
- [ ] Stopping Postgres makes both containers report `unhealthy` within ~2 minutes.
- [ ] Stopping Meilisearch leaves both containers `healthy`, with the failure visible in the `checks.meilisearch` field.
- [ ] `pnpm verify` passes; coverage floor met or raised.
- [ ] Production GitOps compose requires **no** change.

## Deliberately out of scope

- Alerting configuration (uptime-kuma / beszel) — lives outside this repo.
- Restart-on-unhealthy — Docker cannot do it natively; no autoheal sidecar.
- Worker metrics — the health server is a natural future home; not now.
