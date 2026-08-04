import { Client } from 'pg';

export type HealthChecks = { database: string; meilisearch: string };

export type ReadyResult = {
  ready: boolean;
  checks: HealthChecks;
};

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
    // connectionTimeoutMillis only bounds the handshake — a query that stalls
    // after connecting (lock contention, replica failover) would otherwise
    // hang forever. query_timeout cancels client-side; statement_timeout
    // tells Postgres to cancel server-side. Both matter: client-side alone
    // leaves the query running on the server, server-side alone doesn't help
    // if the connection itself is wedged.
    query_timeout: PROBE_TIMEOUT_MS,
    statement_timeout: PROBE_TIMEOUT_MS,
  });
  try {
    await client.connect();
  } catch (e) {
    // A client whose connect() rejected is already torn down by node-postgres
    // — there is no live connection for end() to close.
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
// each probe is bounded to PROBE_TIMEOUT_MS (connect, query, and fetch all
// carry their own timeout), so sequential probes would leave almost no
// margin and an unbounded probe could blow the budget entirely.
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
