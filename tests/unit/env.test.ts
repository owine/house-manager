import { describe, expect, it } from 'vitest';
import { parseEnv } from '@/lib/env';

describe('parseEnv', () => {
  it('parses a valid environment', () => {
    const env = parseEnv({
      ANTHROPIC_API_KEY: 'sk-ant-test-fixture',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      AUTH_SECRET: 'a'.repeat(32),
      AUTH_OIDC_ISSUER: 'https://auth.example.com',
      AUTH_OIDC_CLIENT_ID: 'house-manager',
      AUTH_OIDC_CLIENT_SECRET: 'secret',
      MEILI_HOST: 'http://meilisearch:7700',
      MEILI_KEY: 'key',
      FILES_DIR: '/data/files',
      NODE_ENV: 'test',
      // Schema requires non-empty strings; not VAPID-shaped to keep secret
      // scanners from flagging the fixture as a leaked key.
      WEB_PUSH_VAPID_PUBLIC_KEY: 'test-vapid-public-key-fixture',
      WEB_PUSH_VAPID_PRIVATE_KEY: 'test-vapid-private-key-fixture',
      WEB_PUSH_CONTACT_EMAIL: 'mailto:test@example.com',
      FORWARDEMAIL_API_KEY: 'test-api-key',
      FORWARDEMAIL_FROM_ADDRESS: 'House Manager <reminders@example.com>',
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
        WEB_PUSH_VAPID_PUBLIC_KEY: 'test-vapid-public-key-fixture',
        WEB_PUSH_VAPID_PRIVATE_KEY: 'test-vapid-private-key-fixture',
        WEB_PUSH_CONTACT_EMAIL: 'mailto:test@example.com',
        FORWARDEMAIL_API_KEY: 'test-api-key',
        FORWARDEMAIL_FROM_ADDRESS: 'House Manager <reminders@example.com>',
      }),
    ).toThrow();
  });
});
