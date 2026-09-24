import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dmarcPassed, dmarcResult } from './auth-results';

// Trimmed from mailauth docs/dmarc.md "DMARC Pass". ForwardEmail copies
// mailauth's `results.dmarc` into the webhook's `dmarc` field verbatim, and
// ingest stores it as authResultsJson.dmarc.
const MAILAUTH_PASS = {
  status: {
    result: 'pass',
    comment: 'p=REJECT',
    header: { from: 'acme.example', d: 'acme.example' },
  },
  domain: 'acme.example',
  policy: 'reject',
  p: 'reject',
  sp: 'reject',
  info: 'dmarc=pass (p=REJECT) header.from=acme.example',
};

/** The shape ingest writes: `{ dkim, spf, dmarc }`. */
const stored = (dmarc: unknown) => ({ dkim: null, spf: null, dmarc });

describe('dmarcPassed', () => {
  it('is true for mailauth’s pass shape', () => {
    expect(dmarcPassed(stored(MAILAUTH_PASS))).toBe(true);
  });

  // Fail-closed: the price of a false negative is one email that waits in
  // triage; the price of a false positive is a stranger writing service history.
  it.each([
    ['DMARC fail', stored({ ...MAILAUTH_PASS, status: { result: 'fail', comment: 'p=NONE' } })],
    [
      'none (sender publishes no DMARC record)',
      stored({ status: { result: 'none' }, domain: 'x.example', info: 'dmarc=none' }),
    ],
    ['temperror', stored({ status: { result: 'temperror' }, domain: 'x.example', info: '' })],
    ['uppercase PASS (mailauth never emits it)', stored({ status: { result: 'PASS' } })],
    ['the pre-fix fixture shape { result: "pass" }', stored({ result: 'pass' })],
    ['a bare "pass" string', stored('pass')],
    ['mailauth false (structurally invalid)', stored(false)],
    ['dmarc: null', stored(null)],
    ['no dmarc key', { dkim: null, spf: null }],
    ['a non-string result', stored({ status: { result: true } })],
    ['a null column', null],
    ['undefined', undefined],
    ['a non-object column', 'pass'],
  ])('is false for %s', (_label, value) => {
    expect(dmarcPassed(value)).toBe(false);
  });
});

describe('dmarcResult', () => {
  it('returns the raw verdict for logging', () => {
    expect(dmarcResult(stored({ status: { result: 'fail' } }))).toBe('fail');
  });

  it('returns null when the stored shape is not mailauth’s', () => {
    expect(dmarcResult(stored({ result: 'pass' }))).toBeNull();
    expect(dmarcResult(null)).toBeNull();
  });
});

describe('the invoice-plain fixture', () => {
  // This fixture once carried a made-up `{ result: 'pass' }`, which the gate
  // correctly reads as NOT passed. Keep it honest.
  it('carries a DMARC pass in mailauth’s real shape', () => {
    const path = join(
      __dirname,
      '..',
      '..',
      'tests',
      'fixtures',
      'inbound-email',
      'invoice-plain.json',
    );
    const fixture = JSON.parse(readFileSync(path, 'utf8')) as { dmarc: unknown };
    expect(dmarcPassed({ dmarc: fixture.dmarc })).toBe(true);
  });
});
