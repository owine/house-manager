// Shared AI-client mock for tests that exercise propose* Server Actions.
//
// Same pattern as _mock-auth: vi.mock('@/lib/ai/client', ...) stays per-file
// (hoisting requirement), but the parse-fn state and helpers live here. The
// per-file vi.mock factory dynamically imports `mockParseFn` and re-exports
// it as the SDK's parse method.
//
// Usage in a test file:
//   import { mockParse, getLastCall, resetMock } from './_mock-ai-client';
//   vi.mock('@/lib/ai/client', async () => {
//     const { mockParseFn } = await import('./_mock-ai-client');
//     return {
//       getAnthropic: vi.fn(() => ({ messages: { parse: mockParseFn } })),
//       ANTHROPIC_MODEL: 'claude-haiku-4-5',
//       ANTHROPIC_MAX_TOKENS: 2048,
//     };
//   });
//   // then in tests:  mockParse(fixture)  /  getLastCall()  /  resetMock() in beforeEach

import { vi } from 'vitest';

let _nextResponse: unknown = null;
let _lastParseArgs: unknown = null;

export const mockParseFn = vi.fn(async (...args: unknown[]) => {
  _lastParseArgs = args[0];
  if (_nextResponse === null) throw new Error('No response queued');
  const r = _nextResponse;
  _nextResponse = null;
  if (r instanceof Error) throw r;
  return r;
});

export function mockParse(response: unknown): void {
  _nextResponse = response;
}

export function mockParseError(err: Error): void {
  _nextResponse = err;
}

export function getLastCall(): Record<string, unknown> | null {
  return _lastParseArgs as Record<string, unknown> | null;
}

export function resetMock(): void {
  _nextResponse = null;
  _lastParseArgs = null;
  mockParseFn.mockClear();
}
