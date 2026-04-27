import { Client } from 'pg';

export type ReadyResult = {
  ready: boolean;
  checks: { database: string; meilisearch: string };
};

export async function isReady(opts: {
  databaseUrl: string;
  meiliUrl: string;
}): Promise<ReadyResult> {
  const checks = { database: 'unchecked', meilisearch: 'unchecked' };

  try {
    const client = new Client({
      connectionString: opts.databaseUrl,
      connectionTimeoutMillis: 2000,
    });
    await client.connect();
    await client.query('SELECT 1');
    await client.end();
    checks.database = 'ok';
  } catch (e) {
    checks.database = `error: ${(e as Error).message}`;
  }

  try {
    const res = await fetch(`${opts.meiliUrl}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    checks.meilisearch = res.ok ? 'ok' : `error: HTTP ${res.status}`;
  } catch (e) {
    checks.meilisearch = `error: ${(e as Error).message}`;
  }

  return { ready: checks.database === 'ok' && checks.meilisearch === 'ok', checks };
}
