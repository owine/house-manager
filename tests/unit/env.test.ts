import { describe, expect, it } from 'vitest';
import { parseEnv } from '@/lib/env';

describe('parseEnv', () => {
  it('parses a valid environment', () => {
    const env = parseEnv({
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      AUTH_SECRET: 'a'.repeat(32),
      AUTH_OIDC_ISSUER: 'https://auth.example.com',
      AUTH_OIDC_CLIENT_ID: 'house-manager',
      AUTH_OIDC_CLIENT_SECRET: 'secret',
      MEILI_HOST: 'http://meilisearch:7700',
      MEILI_KEY: 'key',
      FILES_DIR: '/data/files',
      NODE_ENV: 'test',
    });
    expect(env.DATABASE_URL).toBe('postgresql://u:p@localhost:5432/db');
  });

  it('rejects missing required vars', () => {
    expect(() => parseEnv({})).toThrow();
  });

  it('rejects short AUTH_SECRET', () => {
    expect(() =>
      parseEnv({
        DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
        AUTH_SECRET: 'short',
        AUTH_OIDC_ISSUER: 'https://auth.example.com',
        AUTH_OIDC_CLIENT_ID: 'x',
        AUTH_OIDC_CLIENT_SECRET: 's',
        MEILI_HOST: 'http://m:7700',
        MEILI_KEY: 'k',
        FILES_DIR: '/data/files',
        NODE_ENV: 'test',
      }),
    ).toThrow();
  });
});
