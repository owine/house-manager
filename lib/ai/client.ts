import Anthropic from '@anthropic-ai/sdk';
import { getEnv } from '@/lib/env';

let _client: Anthropic | undefined;

export function getAnthropic(): Anthropic {
  if (!_client) {
    _client = new Anthropic({
      apiKey: getEnv().ANTHROPIC_API_KEY,
      // Default timeout 30s — the spec's error matrix expects this.
      timeout: 30_000,
      maxRetries: 1, // SDK retries once; we add one outer retry in actions.ts.
    });
  }
  return _client;
}

export const ANTHROPIC_MODEL = 'claude-haiku-4-5' as const;
export const ANTHROPIC_MAX_TOKENS = 2048;
