import * as Sentry from '@sentry/node';
import { describe, expect, it, vi } from 'vitest';
import { getLogger } from '@/lib/logger';
import { getErrorReporter } from '@/lib/observability/error-reporter';
import { initWorkerSentry } from './sentry';

// The real @sentry/node SDK end to end: our options, our beforeSend, our
// bridge, the SDK's own capture bookkeeping. Only the transport is fake, so
// every assertion is about what would actually leave the process.
//
// Tests run in order and share one SDK client (Sentry state is global).

type SentEvent = {
  level?: string;
  tags?: Record<string, string>;
  exception?: { values?: Array<{ type?: string; value?: string }> };
};
const sent: SentEvent[] = [];
const transport = () => ({
  send: async (envelope: unknown) => {
    const [, items] = envelope as [unknown, Array<[{ type: string }, unknown]>];
    for (const [header, payload] of items) {
      if (header.type === 'event') sent.push(payload as SentEvent);
    }
    return {};
  },
  flush: async () => true,
});

const DSN = 'https://publickey@glitchtip.example/1';
// Built from parts so no credentialed URL appears literally in the source.
const DB_USER = 'housemanager';
const DB_PW = 's3cr3tP%40ss';
const DB_URL = `postgresql://${DB_USER}:${DB_PW}@db-host:5432/housemanager`;
const MASKED_DB_URL = DB_URL.replace(DB_PW, '***');

async function drain(): Promise<SentEvent[]> {
  await Sentry.flush(2_000);
  return sent.splice(0);
}

describe('worker Sentry', () => {
  it('without a DSN: no client, no bridge', () => {
    // The default argument reads process.env.SENTRY_DSN; a developer's .env
    // must not turn this into a real init.
    vi.stubEnv('SENTRY_DSN', '');
    expect(initWorkerSentry()).toBe(false);
    vi.unstubAllEnvs();
    expect(initWorkerSentry(undefined)).toBe(false);
    expect(initWorkerSentry('')).toBe(false);
    expect(Sentry.getClient()).toBeUndefined();
    expect(getErrorReporter()).toBeUndefined();
  });

  it('with a DSN: inits and installs the bridge', () => {
    // defaultIntegrations off: no process-wide handlers inside the test runner.
    expect(initWorkerSentry(DSN, { transport, defaultIntegrations: false })).toBe(true);
    expect(Sentry.getClient()).toBeDefined();
    expect(getErrorReporter()).toBeDefined();
    // Installed with incoming-body capture off (see worker/sentry.ts).
    expect(Sentry.getClient()?.getIntegrationByName('Http')).toBeDefined();
  });

  it('logger.error({ err }) sends one scrubbed event tagged with the module', async () => {
    getLogger('worker.embed-content').error(
      { err: new Error(`cannot reach ${DB_URL}`), event: 'embed.failed' },
      'embed-content: failed',
    );

    const events = await drain();
    expect(events).toHaveLength(1);
    expect(events[0].level).toBe('error');
    expect(events[0].tags).toMatchObject({ module: 'worker.embed-content', event: 'embed.failed' });
    expect(events[0].exception?.values?.[0]?.value).toBe(`cannot reach ${MASKED_DB_URL}`);
    // Nowhere in the event: message, stack frames, extra, tags.
    expect(JSON.stringify(events[0])).not.toContain('s3cr3tP');
  });

  it('captureException then logger.error of the same err sends ONE event', async () => {
    const err = new Error('pg-boss error');
    Sentry.captureException(err);
    getLogger('queue').error({ err }, 'pg-boss error');

    expect(await drain()).toHaveLength(1);
    // Pins the SDK flag the bridge relies on. If a future @sentry/* renames
    // it, this fails before duplicate events reach production.
    expect((err as { __sentry_captured__?: boolean }).__sentry_captured__).toBe(true);
  });

  // The other order: the bridge reports first, so the SDK must see the SAME
  // object the call site captures next. Mutation-checked: making the bridge
  // wrap the error (a new Error with the original as `cause`) sends 2 events.
  it('logger.error then captureException of the same err sends ONE event', async () => {
    const err = new Error('auto-stub failed');
    getLogger('worker.classify').error({ err }, 'auto-stub failed');
    Sentry.captureException(err);

    expect(await drain()).toHaveLength(1);
  });

  it('an error line without an Error adds nothing to an explicit capture (pg-dump)', async () => {
    getLogger('worker.pg-dump').error({ event: 'pg-dump.failed', code: 1 }, 'pg_dump failed');
    Sentry.captureException(new Error('Command failed: pg_dump'));

    expect(await drain()).toHaveLength(1);
  });

  it('warn is never sent', async () => {
    getLogger('worker.embed-content').warn({ err: new Error('429') }, 'will retry');
    expect(await drain()).toHaveLength(0);
  });
});
