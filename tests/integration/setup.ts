import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';

export type TestStack = {
  postgres: StartedPostgreSqlContainer;
  meili: StartedTestContainer;
  databaseUrl: string;
  meiliUrl: string;
};

export async function startStack(): Promise<TestStack> {
  const postgres = await new PostgreSqlContainer('pgvector/pgvector:pg16')
    .withDatabase('housemanager')
    .withUsername('housemanager')
    .withPassword('test')
    .start();
  const meili = await new GenericContainer('getmeili/meilisearch:v1.10')
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
