import { afterEach, describe, expect, it, vi } from 'vitest';

// APP_GIT_SHA is computed at module load, so each case re-imports it.
async function load(env: { NEXT_PUBLIC_GIT_SHA?: string; GIT_SHA?: string }) {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_GIT_SHA', env.NEXT_PUBLIC_GIT_SHA);
  vi.stubEnv('GIT_SHA', env.GIT_SHA);
  return (await import('./git-sha')).APP_GIT_SHA;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('APP_GIT_SHA', () => {
  it('prefers the build-time NEXT_PUBLIC_GIT_SHA (web bundles)', async () => {
    expect(await load({ NEXT_PUBLIC_GIT_SHA: 'abcdef1234567', GIT_SHA: '9999999999' })).toBe(
      'abcdef1',
    );
  });

  // The worker image has only the runtime-stage GIT_SHA. Mutation-checked:
  // dropping the fallback makes this 'dev', which is what prod reported.
  it('falls back to the runtime GIT_SHA (the worker under tsx)', async () => {
    expect(await load({ GIT_SHA: '1234567890abc' })).toBe('1234567');
  });

  it('is dev when neither is set', async () => {
    expect(await load({})).toBe('dev');
  });
});
