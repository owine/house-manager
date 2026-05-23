import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveIssuer } from './mock-oidc';

describe('resolveIssuer', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to http://localhost:<port> when MOCK_OIDC_ISSUER is unset', () => {
    // stubEnv(_, undefined) deletes the var, so resolveIssuer sees it as unset.
    vi.stubEnv('MOCK_OIDC_ISSUER', undefined);
    expect(resolveIssuer(9999)).toBe('http://localhost:9999');
  });

  it('returns MOCK_OIDC_ISSUER verbatim when set', () => {
    vi.stubEnv('MOCK_OIDC_ISSUER', 'http://host.docker.internal:9999');
    expect(resolveIssuer(9999)).toBe('http://host.docker.internal:9999');
  });
});
