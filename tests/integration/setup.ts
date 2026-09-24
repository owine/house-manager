import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';

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
const MEILI_IMAGE = 'getmeili/meilisearch:v1.53';

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
export function startPostgres(): Promise<StartedPostgreSqlContainer> {
  return new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('housemanager')
    .withUsername('housemanager')
    .withPassword('test')
    .start();
}

export async function startStack(): Promise<TestStack> {
  const postgres = await startPostgres();
  const meili = await new GenericContainer(MEILI_IMAGE)
    .withEnvironment({ MEILI_MASTER_KEY: 'test', MEILI_ENV: 'development' })
    .withExposedPorts(7700)
    .start();
  return {
    postgres,
    meili,
    databaseUrl: postgres.getConnectionUri(),
    meiliUrl: `http://${meili.getHost()}:${meili.getMappedPort(7700)}`,
  };
}

export async function stopStack(stack: TestStack) {
  await stack.postgres.stop();
  await stack.meili.stop();
}
