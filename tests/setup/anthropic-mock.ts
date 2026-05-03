import { vi } from 'vitest';

type ParsedResponse = {
  parsed_output: unknown;
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
};

let nextResponse: ParsedResponse | Error | null = null;
let lastCall: { args: unknown[] } | null = null;

export function mockMessagesParse(response: ParsedResponse): void {
  nextResponse = response;
}

export function mockMessagesParseError(err: Error): void {
  nextResponse = err;
}

export function getLastParseCall(): { args: unknown[] } | null {
  return lastCall;
}

export function resetAnthropicMock(): void {
  nextResponse = null;
  lastCall = null;
}

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = {
      parse: vi.fn(async (...args: unknown[]) => {
        lastCall = { args };
        if (nextResponse === null) {
          throw new Error(
            'Anthropic mock: no response queued. Call mockMessagesParse(fixture) first.',
          );
        }
        const r = nextResponse;
        nextResponse = null; // single-shot
        if (r instanceof Error) throw r;
        return r;
      }),
    };
  }
  return { default: MockAnthropic };
});
