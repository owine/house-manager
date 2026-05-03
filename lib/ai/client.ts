// SDK verification — @anthropic-ai/sdk ~0.92.0 (pinned in package.json)
//
// output_config / zodOutputFormat / messages.parse():
//   GA on all current models including claude-haiku-4-5. No beta header required.
//   Supported models per SDK docs: Opus 4.7, Sonnet 4.6, Haiku 4.5 (and legacy 4.x).
//   Usage: client.messages.parse({ model, output_config: { format: zodOutputFormat(schema) } })
//
// cache_control system-block array syntax (confirmed current):
//   system accepts TextBlockParam[] where each block may carry
//   cache_control: { type: 'ephemeral' } (default 5-min TTL) or
//   cache_control: { type: 'ephemeral', ttl: '1h' } (1-hour TTL).
//   Minimum cacheable prefix: 4096 tokens for Haiku 4.5.
//   Placement: breakpoint on the *last* block caches everything before it
//   (tools → system → messages render order). Volatile inventory block
//   receives the marker so the stable system prompt + house profile are
//   cached together on repeated calls.
//
// betaZodTool fallback: not needed — output_config is GA on Haiku 4.5.
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
