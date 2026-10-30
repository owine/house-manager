import { request } from 'node:http';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { inject } from 'vitest';

/**
 * Container images for the integration stack.
 *
 * These are ordinary pinned dependencies and are held to the same rule as
 * every other pin in the repo -- but they live in a `.ts` file, which NO
 * first-party Renovate manager can read. Left bare they are invisible: no PR,
 * no error, no Dependency Dashboard entry, exactly the failure mode that hid
 * tests/e2e/visual.Dockerfile from #171 until #323. The `renovate:` annotation
 * above each constant is what makes them visible, via the `annotated image
 * pins` customManager in renovate.json.
 *
 * Keep the annotation on the line DIRECTLY above the constant, and keep the
 * value a single quoted `image:tag` literal -- the manager matches that shape
 * and silently tracks nothing if either moves.
 */
// renovate: datasource=docker depName=pgvector/pgvector
const POSTGRES_IMAGE = 'pgvector/pgvector:pg18';
// renovate: datasource=docker depName=getmeili/meilisearch
const MEILI_IMAGE = 'getmeili/meilisearch:v1.55';

export type TestStack = {
  postgres: StartedPostgreSqlContainer;
  meili: StartedTestContainer;
  databaseUrl: string;
  meiliUrl: string;
};

/**
 * A bare Postgres from the stack's image, credentials and database name. The
 * stack uses it, and so does any test that needs a second, empty server --
 * e.g. restoring a dump somewhere other than where it was taken.
 */
function postgresContainer() {
  return new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('housemanager')
    .withUsername('housemanager')
    .withPassword('test');
}

export function startPostgres(): Promise<StartedPostgreSqlContainer> {
  return postgresContainer().start();
}

/**
 * The one server every integration file shares (./global-setup.ts), so it is
 * tuned for that rather than for being one of 76:
 *
 * - `max_connections`: files run concurrently against it, each with Prisma's and
 *   pg-boss's pools, and the worker count is the host's CPU count -- the default
 *   100 is reachable on a 10-core laptop.
 * - `fsync` / `synchronous_commit` / `full_page_writes` off: durability across a
 *   crash is meaningless for a container that is thrown away when the run ends,
 *   and it is the one server now absorbing every file's writes.
 */
export function startSharedPostgres(): Promise<StartedPostgreSqlContainer> {
  return postgresContainer()
    .withCommand([
      'postgres',
      '-c',
      'max_connections=500',
      '-c',
      'fsync=off',
      '-c',
      'synchronous_commit=off',
      '-c',
      'full_page_writes=off',
    ])
    .start();
}

export function startMeili(): Promise<StartedTestContainer> {
  return new GenericContainer(MEILI_IMAGE)
    .withEnvironment({ MEILI_MASTER_KEY: 'test', MEILI_ENV: 'development' })
    .withExposedPorts(7700)
    .start();
}

export function meiliUrlOf(meili: StartedTestContainer): string {
  return `http://${meili.getHost()}:${meili.getMappedPort(7700)}`;
}

/**
 * A fresh, fully migrated database of this file's own on the shared server,
 * plus the call that drops it. See ./global-setup.ts.
 *
 * Talks to the broker with `node:http` rather than `fetch` on purpose: a test
 * that stubs the global `fetch` (Voyage and Anthropic are both fetch-based)
 * would otherwise swallow the teardown DELETE and leak its database silently.
 */
export async function acquireDatabase(): Promise<{
  databaseUrl: string;
  release: () => Promise<void>;
}> {
  const broker = inject('integrationDbBroker');
  if (!broker) {
    throw new Error(
      'integrationDbBroker was not provided: tests/integration/global-setup.ts must be in vitest.config.ts globalSetup',
    );
  }
  const { name, databaseUrl } = JSON.parse(await brokerCall(broker, 'POST', '/databases')) as {
    name: string;
    databaseUrl: string;
  };
  return {
    databaseUrl,
    release: async () => {
      await brokerCall(broker, 'DELETE', `/databases/${name}`);
    },
  };
}

function brokerCall(broker: string, method: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(new URL(path, broker), { method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode === 200) resolve(body);
        else
          reject(
            new Error(`integration DB broker ${method} ${path} -> ${res.statusCode}\n${body}`),
          );
      });
    });
    req.on('error', reject);
    req.end();
  });
}

export async function startStack(): Promise<TestStack> {
  const postgres = await startPostgres();
  const meili = await startMeili();
  return {
    postgres,
    meili,
    databaseUrl: postgres.getConnectionUri(),
    meiliUrl: meiliUrlOf(meili),
  };
}

export async function stopStack(stack: TestStack) {
  await stack.postgres.stop();
  await stack.meili.stop();
}
