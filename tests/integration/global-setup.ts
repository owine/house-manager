import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Pool } from 'pg';
import type { TestProject } from 'vitest/node';

/**
 * One Postgres for the whole integration run, and a fresh database per test file.
 *
 * Every file used to start its own Postgres container and run `prisma migrate
 * deploy` into it. That is ~6s per file on a CI runner before a single test runs
 * -- a one-test file took 6.0s, most files took 7-8s, and across 76 files it was
 * roughly 60% of the suite's worker time. Here the container starts and migrates
 * ONCE; each file then gets `CREATE DATABASE … TEMPLATE housemanager`, which
 * copies the already-migrated database in ~30ms. Isolation is unchanged: every
 * file still starts from an empty, fully migrated database of its own, and its
 * database is dropped (WITH FORCE, which also cuts any connection the file
 * leaked -- what stopping its container used to do) when it finishes.
 *
 * Why a broker over HTTP rather than just starting the container here: this
 * config is shared by unit and integration runs, and nothing tells a global
 * setup which files a run will include. Starting Postgres eagerly would make
 * every unit run need Docker. So this only opens a loopback server (no Docker,
 * no I/O), and the container starts on the FIRST request -- which only
 * `setupIntegration()` makes. A unit-only run never asks and never pays; a
 * single-file `vitest run tests/integration/x.test.ts`, `test:integration` and
 * the combined `test:coverage:check` all share one container automatically.
 *
 * Meilisearch is deliberately NOT shared: the app hard-codes one index name
 * (`SEARCH_INDEX_NAME`), so files running at once would trample each other's
 * index. A Meilisearch container starts in ~0.2s, so `setupIntegration()` keeps
 * one per file.
 *
 * Workers reach this through `inject('integrationDbBroker')` -- see
 * `acquireDatabase()` in ./setup.ts.
 */

declare module 'vitest' {
  export interface ProvidedContext {
    integrationDbBroker: string;
  }
}

const execFileAsync = promisify(execFile);

/** The database migrations run into; every per-file database is cloned from it. */
const TEMPLATE_DB = 'housemanager';
/** Only names this broker minted may be dropped through it. */
const DB_NAME = /^it_\d+$/;

type Shared = {
  container: StartedPostgreSqlContainer;
  admin: Pool;
  urlFor: (database: string) => string;
};

async function startShared(): Promise<Shared> {
  // Imported lazily so a unit-only run never loads testcontainers at all.
  const { startSharedPostgres } = await import('./setup');
  const { Pool } = await import('pg');

  const container = await startSharedPostgres();
  const templateUrl = container.getConnectionUri();
  await execFileAsync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: templateUrl },
  });

  const urlFor = (database: string) => {
    const url = new URL(templateUrl);
    url.pathname = `/${database}`;
    return url.toString();
  };
  // Connected to `postgres`, never to the template: CREATE DATABASE … TEMPLATE
  // refuses to copy a database that has any other session in it.
  const admin = new Pool({ connectionString: urlFor('postgres'), max: 4 });
  return { container, admin, urlFor };
}

export default async function setup(project: TestProject) {
  let shared: Promise<Shared> | undefined;
  let created = 0;

  async function handle(req: IncomingMessage): Promise<object> {
    // A failed start stays failed: every file then reports the same root cause
    // instead of each one retrying a container that cannot come up.
    shared ??= startShared();
    const { admin, urlFor } = await shared;
    const path = req.url ?? '/';

    if (req.method === 'POST' && path === '/databases') {
      const name = `it_${++created}`;
      await admin.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`);
      return { name, databaseUrl: urlFor(name) };
    }
    if (req.method === 'DELETE' && path.startsWith('/databases/')) {
      const name = path.slice('/databases/'.length);
      if (!DB_NAME.test(name)) throw new Error(`refusing to drop database "${name}"`);
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      return {};
    }
    throw new Error(`no route for ${req.method} ${path}`);
  }

  const server = createServer((req, res) => {
    handle(req).then(
      (body) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      },
      (err: unknown) => {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(err instanceof Error ? (err.stack ?? err.message) : String(err));
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  project.provide('integrationDbBroker', `http://127.0.0.1:${port}`);

  return async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    const started = await shared?.catch(() => undefined);
    if (!started) return;
    await started.admin.end();
    await started.container.stop();
  };
}
