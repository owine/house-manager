import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as Sentry from '@sentry/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initWorkerSentry } from './sentry';

// The span BACKSTOP in lib/observability/sentry-options.ts, against the real
// @sentry/node SDK. Only the transport is fake.
//
// Why this file exists: the backstop used to be `beforeSendTransaction: () =>
// null`, and SDK 11's default `traceLifecycle: 'stream'` never calls it. The
// unit test asserted the callback returned null, which stayed true while the
// SDK stopped invoking it, so the backstop was dead for months with every test
// green. A backstop can only be seen working with the primary defense removed,
// so this init drops `tracesSampler` and keeps `tracesSampleRate: 0`. That is
// exactly the config that leaked: a request carrying a sampled remote
// `sentry-trace` parent gets a sampled server span despite the 0 rate.
//
// Checked both ways when written: with `ignoreSpans` removed from the options,
// this test fails with a `span` item for the GET (the same probe also showed
// `beforeSendTransaction` doing nothing under the default lifecycle).
//
// Separate file from ./sentry.test.ts: Sentry state is global, and that file's
// client keeps the full options.

const items: string[] = [];
const transport = () => ({
  send: async (envelope: unknown) => {
    const [, envelopeItems] = envelope as [unknown, Array<[{ type: string }, unknown]>];
    for (const [header] of envelopeItems) items.push(header.type);
    return {};
  },
  flush: async () => true,
});

let server: http.Server;
let port: number;

beforeAll(async () => {
  initWorkerSentry('https://publickey@glitchtip.example/1', {
    transport,
    defaultIntegrations: false,
    tracesSampler: undefined,
  });
  server = http.createServer((_req, res) => res.end('ok'));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Sentry.close(2_000);
});

describe('span backstop (ignoreSpans), with tracesSampler removed', () => {
  it('a request with a sampled remote sentry-trace parent sends no span or transaction', async () => {
    await new Promise<void>((resolve, reject) => {
      http
        .get(
          {
            port,
            // The shape that leaked in H1: a secret-bearing path and a query.
            path: '/api/calendar/SECRET-TOKEN.ics?x=1',
            headers: { 'sentry-trace': `${'a'.repeat(32)}-${'b'.repeat(16)}-1` },
          },
          (res) => res.resume().on('end', resolve),
        )
        .on('error', reject);
    });
    await Sentry.flush(3_000);

    expect(items.filter((t) => t === 'span' || t === 'transaction')).toEqual([]);
  });
});
