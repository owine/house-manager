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
      INBOUND_EMAIL_TOKEN: 'test-inbound-token-1234567890ab',
      INBOUND_EMAIL_HMAC_KEY: 'test-inbound-hmac-key-1234567890',
    });
    expect(env.DATABASE_URL).toBe('postgresql://u:p@localhost:5432/db');
  });

  it('rejects missing required vars', () => {
    expect(() => parseEnv({})).toThrow();
  });

  it('treats INBOUND_EMAIL_* as optional (inbox feature is opt-in)', () => {
    const baseValid = {
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
      WEB_PUSH_VAPID_PUBLIC_KEY: 'test-vapid-public-key-fixture',
      WEB_PUSH_VAPID_PRIVATE_KEY: 'test-vapid-private-key-fixture',
      WEB_PUSH_CONTACT_EMAIL: 'mailto:test@example.com',
      FORWARDEMAIL_API_KEY: 'test-api-key',
      FORWARDEMAIL_FROM_ADDRESS: 'House Manager <reminders@example.com>',
    };
    expect(() => parseEnv(baseValid)).not.toThrow();
    const env = parseEnv(baseValid);
    expect(env.INBOUND_EMAIL_TOKEN).toBeUndefined();
    expect(env.INBOUND_EMAIL_HMAC_KEY).toBeUndefined();
  });

  // Regression: the Dockerfile's `ARG SENTRY_DSN` + `ENV SENTRY_DSN=$SENTRY_DSN`
  // pattern produces an empty-string ENV when no --build-arg is passed. A bare
  // `.url().optional()` rejects empty string (not undefined, not a valid URL),
  // which broke the prod docker build after Plan 5a shipped. The schema now
  // tolerates empty string as a stand-in for unset.
  it('treats empty SENTRY_DSN as unset', () => {
    const baseValid = {
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
      WEB_PUSH_VAPID_PUBLIC_KEY: 'test-vapid-public-key-fixture',
      WEB_PUSH_VAPID_PRIVATE_KEY: 'test-vapid-private-key-fixture',
      WEB_PUSH_CONTACT_EMAIL: 'mailto:test@example.com',
      FORWARDEMAIL_API_KEY: 'test-api-key',
      FORWARDEMAIL_FROM_ADDRESS: 'House Manager <reminders@example.com>',
      INBOUND_EMAIL_TOKEN: 'test-inbound-token-1234567890ab',
      INBOUND_EMAIL_HMAC_KEY: 'test-inbound-hmac-key-1234567890',
    };
    expect(() => parseEnv({ ...baseValid, SENTRY_DSN: '' })).not.toThrow();
  });

  it('rejects malformed SENTRY_DSN that is non-empty but not a URL', () => {
    const baseValid = {
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
      WEB_PUSH_VAPID_PUBLIC_KEY: 'test-vapid-public-key-fixture',
      WEB_PUSH_VAPID_PRIVATE_KEY: 'test-vapid-private-key-fixture',
      WEB_PUSH_CONTACT_EMAIL: 'mailto:test@example.com',
      FORWARDEMAIL_API_KEY: 'test-api-key',
      FORWARDEMAIL_FROM_ADDRESS: 'House Manager <reminders@example.com>',
      INBOUND_EMAIL_TOKEN: 'test-inbound-token-1234567890ab',
      INBOUND_EMAIL_HMAC_KEY: 'test-inbound-hmac-key-1234567890',
    };
    expect(() => parseEnv({ ...baseValid, SENTRY_DSN: 'not-a-url' })).toThrow();
  });

  // Same failure mode as the SENTRY_DSN case above, on every other optional
  // var: an env file line left as `VOYAGE_API_KEY=` yields '', which is
  // neither undefined nor a value that clears `.min(1)` / `.url()`. Before
  // `optionalEnv`, that made the whole process fail to boot over a var the
  // schema calls optional — and made getEnv() throw in every Vitest worker on
  // a machine whose .env has one.
  it('treats an empty optional var as unset', () => {
    const baseValid = {
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
      WEB_PUSH_VAPID_PUBLIC_KEY: 'test-vapid-public-key-fixture',
      WEB_PUSH_VAPID_PRIVATE_KEY: 'test-vapid-private-key-fixture',
      WEB_PUSH_CONTACT_EMAIL: 'mailto:test@example.com',
      FORWARDEMAIL_API_KEY: 'test-api-key',
      FORWARDEMAIL_FROM_ADDRESS: 'House Manager <reminders@example.com>',
    };
    const env = parseEnv({
      ...baseValid,
      VOYAGE_API_KEY: '',
      APP_URL: '',
      INBOUND_EMAIL_TOKEN: '',
      INBOUND_EMAIL_HMAC_KEY: '',
    });
    expect(env.VOYAGE_API_KEY).toBeUndefined();
    expect(env.APP_URL).toBeUndefined();
    expect(env.INBOUND_EMAIL_TOKEN).toBeUndefined();
    expect(env.INBOUND_EMAIL_HMAC_KEY).toBeUndefined();
  });

  it('rejects too-short INBOUND_EMAIL_TOKEN / INBOUND_EMAIL_HMAC_KEY (16 char min)', () => {
    const baseValid = {
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
      WEB_PUSH_VAPID_PUBLIC_KEY: 'test-vapid-public-key-fixture',
      WEB_PUSH_VAPID_PRIVATE_KEY: 'test-vapid-private-key-fixture',
      WEB_PUSH_CONTACT_EMAIL: 'mailto:test@example.com',
      FORWARDEMAIL_API_KEY: 'test-api-key',
      FORWARDEMAIL_FROM_ADDRESS: 'House Manager <reminders@example.com>',
      INBOUND_EMAIL_TOKEN: 'test-inbound-token-1234567890ab',
      INBOUND_EMAIL_HMAC_KEY: 'test-inbound-hmac-key-1234567890',
    };
    expect(() => parseEnv({ ...baseValid, INBOUND_EMAIL_TOKEN: 'short-tok' })).toThrow();
    expect(() => parseEnv({ ...baseValid, INBOUND_EMAIL_HMAC_KEY: 'short-hmac' })).toThrow();
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

  // BACKUP_HEARTBEAT_URL is the pg-dump dead-man ping. Optional like the rest,
  // but http(s) only: the worker fetch()es it, and a bare `.url()` would accept
  // `ftp:` or `javascript:` and only fail at 03:00.
  it('BACKUP_HEARTBEAT_URL: optional, empty is unset, http(s) only', () => {
    const baseValid = {
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
      WEB_PUSH_VAPID_PUBLIC_KEY: 'test-vapid-public-key-fixture',
      WEB_PUSH_VAPID_PRIVATE_KEY: 'test-vapid-private-key-fixture',
      WEB_PUSH_CONTACT_EMAIL: 'mailto:test@example.com',
      FORWARDEMAIL_API_KEY: 'test-api-key',
      FORWARDEMAIL_FROM_ADDRESS: 'House Manager <reminders@example.com>',
    };
    expect(parseEnv(baseValid).BACKUP_HEARTBEAT_URL).toBeUndefined();
    expect(
      parseEnv({ ...baseValid, BACKUP_HEARTBEAT_URL: '' }).BACKUP_HEARTBEAT_URL,
    ).toBeUndefined();
    const url = 'https://kuma.example.com/api/push/Ab12Cd34?status=up&msg=OK&ping=';
    expect(parseEnv({ ...baseValid, BACKUP_HEARTBEAT_URL: url }).BACKUP_HEARTBEAT_URL).toBe(url);
    expect(() =>
      parseEnv({ ...baseValid, BACKUP_HEARTBEAT_URL: 'ftp://kuma.example.com/x' }),
    ).toThrow();
    expect(() => parseEnv({ ...baseValid, BACKUP_HEARTBEAT_URL: 'not a url' })).toThrow();
  });

  // The two job heartbeats share BACKUP_HEARTBEAT_URL's contract exactly.
  it('REMINDERS_TICK / SEARCH_REINDEX heartbeat URLs: optional, empty is unset, http(s) only', () => {
    const baseValid = {
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
      WEB_PUSH_VAPID_PUBLIC_KEY: 'test-vapid-public-key-fixture',
      WEB_PUSH_VAPID_PRIVATE_KEY: 'test-vapid-private-key-fixture',
      WEB_PUSH_CONTACT_EMAIL: 'mailto:test@example.com',
      FORWARDEMAIL_API_KEY: 'test-api-key',
      FORWARDEMAIL_FROM_ADDRESS: 'House Manager <reminders@example.com>',
    };
    const url = 'http://uptime-kuma:3001/api/push/Ab12Cd34?status=up&msg=OK&ping=';
    for (const key of ['REMINDERS_TICK_HEARTBEAT_URL', 'SEARCH_REINDEX_HEARTBEAT_URL'] as const) {
      expect(parseEnv(baseValid)[key]).toBeUndefined();
      expect(parseEnv({ ...baseValid, [key]: '' })[key]).toBeUndefined();
      expect(parseEnv({ ...baseValid, [key]: url })[key]).toBe(url);
      expect(() => parseEnv({ ...baseValid, [key]: 'ftp://kuma.example.com/x' })).toThrow();
      expect(() => parseEnv({ ...baseValid, [key]: 'not a url' })).toThrow();
    }
  });
});
