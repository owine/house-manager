# Container healthchecks — design

**Date:** 2026-08-04
**Status:** approved, not yet implemented

## Motivation

On 2026-07-30, PR #333 added an import of `@/components/parts/kind-labels` to
`lib/embedding/canonicalize.ts`. `components/` is not copied into the
Dockerfile's runtime stage, so `housemanager-worker` crash-looped at boot with
`ERR_MODULE_NOT_FOUND` — 792 restarts over five days. The web container sat
next to it reporting `healthy` the whole time. Nothing alerted.

The import bug is fixed (#371, plus a `lint:worker-graph` guard). This spec
covers the *observability* half: the worker had no health signal at all, and
web's was decorative.

### What a HEALTHCHECK does and does not buy

Docker only probes **running** containers. The worker died seconds into boot,
so a healthcheck would never have executed — the container would have sat at
`health: starting` and then been killed and restarted, forever.

So a healthcheck does **not**, by itself, catch a crash-loop. It catches it
only if the consuming monitor treats **anything other than `healthy`** as down,
rather than waiting for `unhealthy`. That distinction is the difference between
catching this outage and missing it again. The alerting side is out of scope
here and is wired manually in uptime-kuma.

What a healthcheck *does* buy directly is detection of a **hung-but-alive**
worker — a process that is running and probeable but no longer servicing the
queue. That failure is quieter than a crash-loop and equally total.

## Constraints discovered

1. **One image, two services.** `Dockerfile` builds a single image; `web` runs
   `pnpm start`, `worker` runs `pnpm worker:start`. A `HEALTHCHECK` instruction
   applies to every container from that image. `Dockerfile:130-132` currently
   documents the decision *not* to add one for exactly this reason — this spec
   reverses that comment.
2. **Compose `healthcheck:` overrides the image's.** The dev
   `docker-compose.yml` web service already defines one; production compose
   lives in a separate GitOps repo.
3. **`lib/health.ts` already exists** and exports `isReady()` (Postgres +
   Meilisearch, used by `/api/health/ready`). It sits in `lib/`, which *is*
   copied into the runtime stage, so the worker can import it — and
   `lint:worker-graph` now enforces that it stays reachable.
4. **`/api/health` is static today.** It returns 200 unconditionally. It is
   what the compose healthcheck probes, so web reports `healthy` with Postgres
   gone.

## Decisions

| Question | Decision |
|---|---|
| Signal fidelity | Full liveness — a hung worker must go unhealthy, not just a dead one |
| Transport | Tiny `node:http` server in the worker |
| Role split | Worker serves the **same port (3000) and path (`/api/health`)** as web |
| Failure contract | Postgres unreachable → unhealthy. Meilisearch unreachable → **healthy**, reported in body |

**On the role split.** Containers have separate network namespaces, so the
worker binding 3000 does not collide with web, and compose publishes only web's
3000 to the host. This lets one `HEALTHCHECK` line be correct for both roles
with no role detection, no env var, no CI change, and **no change to the GitOps
compose**. The alternatives — a `SERVICE_ROLE` env var with a dispatch script,
or splitting into two build targets with two published tags — both spread the
change across repos to buy nothing this doesn't already have.

**On the failure contract.** Search is eventually consistent by design
(`enqueueSearchIndex` swallows errors; the nightly `search.reindex` recovers).
A Meilisearch outage degrades the app; it does not break it, and should not
page. Postgres is different: without it neither role can do anything.

## Design

### 1. `lib/health.ts` — one shared contract

Extract the two existing probes into `probeDatabase()` and
`probeMeilisearch()`, then add:

```ts
export type HealthResult = {
  status: 'ok' | 'down';
  checks: { database: string; meilisearch: string };
};

export async function checkHealth(opts: {
  databaseUrl: string;
  meiliUrl: string;
}): Promise<HealthResult>;
```

`status` is derived from `database` alone. `isReady()` keeps its current
stricter semantics (both must be `ok`) and is rebuilt on the same two probes,
so each probe has exactly one implementation.

### 2. Web — `/api/health` gets teeth

`app/api/health/route.ts` becomes async, calls `checkHealth`, and returns 200
or 503 while keeping `version` and `sha` in the body. `/api/health/ready` is
untouched.

This is a deliberate semantic change: `/api/health` stops being a pure liveness
probe. Under a strict liveness/readiness split that is a smell, because a
supervisor that restarts on liveness failure would restart-loop web through a
Postgres outage. Nothing in this stack does that — Docker restarts *exited*
containers, not `unhealthy` ones — so the risk does not apply. **If this ever
runs under Kubernetes or anything else that restarts on liveness failure, this
is the decision to revisit.**

### 3. Worker — `worker/health-server.ts`

A minimal `node:http` server on 3000 serving `/api/health`; every other path
404s. Healthy requires **both** conditions:

- `checkHealth().status === 'ok'` — the same shared contract web uses
- the heartbeat is fresh

The heartbeat is a 30s `setInterval` that stamps `lastHeartbeatAt` only after a
successful cheap pg-boss probe (`boss.getQueueSize(...)`, which is DB-backed
and proves the connection is usable). Stale threshold 120s — four missed beats.

Interval-driven rather than job-driven on purpose: ticks are 5 minutes apart at
best and an idle house can go hours without work, so job-completion heartbeats
would false-positive constantly. The interval tests *can this process still
service the queue*, independent of whether there is work.

`.unref()` the timer and return an idempotent `stop()`, following
`lib/observability/memory-watchdog.ts` — the established pattern for
interval-based background concerns in this worker. A timer that keeps the event
loop alive would turn clean shutdown into a hang.

**The server starts before `boss.start()`** and reports 503 (`status: 'starting'`)
until the first successful heartbeat. A worker wedged connecting to Postgres
therefore shows *unhealthy* rather than being unprobeable. Sentry init stays the
first import in `worker/index.ts` per CLAUDE.md.

### 4. Dockerfile

Replace the comment at `Dockerfile:130-132` with:

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD curl -fsS http://localhost:3000/api/health || exit 1
```

`curl` is already installed in the runtime stage. `start-period=120s` covers
web's `db:deploy && db:seed` on boot; failures during that window do not count
toward `retries`.

`tests/e2e/visual.Dockerfile` is **not** touched — it is a Playwright harness
that runs to completion, so a healthcheck is meaningless there.

### 5. Compose

Remove web's explicit `healthcheck:` block from `docker-compose.yml` — the
image default now covers it, leaving one definition instead of two that can
drift. Remove the worker's "no healthcheck" comment. Production GitOps needs no
change.

### 6. Tests

- `lib/health.test.ts` — `checkHealth`: DB down → `status: 'down'`; Meili down →
  `status: 'ok'` with the error surfaced in `checks.meilisearch`; both ok → `ok`.
  Confirm `isReady` still treats Meili as fatal (guards against the refactor
  leaking the looser contract into the stricter endpoint).
- `worker/health-server.test.ts` — starting → ok → stale transitions against an
  injected clock; boundary exactly at the threshold; unknown path 404s. Bind an
  ephemeral port.
- `tests/integration/health.test.ts` — update; it currently asserts an
  unconditional 200 from `/api/health`.

### 7. Docs

`docs/README.md:36` describes `/api/health` as liveness — reword to reflect the
DB-backed contract and note that the worker serves the same path.

## Out of scope

- Alerting. Uptime-kuma / beszel configuration is manual and lives outside this
  repo. Note again that the monitor must treat *not healthy* as down, not just
  *unhealthy*, or a crash-loop stays invisible.
- Restart-on-unhealthy. Docker cannot do this natively and no autoheal sidecar
  is being introduced.
- Worker metrics. The health server is a natural future home for them; not now.
