// SDK notes — @anthropic-ai/sdk, exact-pinned in package.json.
//
// output_config / zodOutputFormat / messages.parse():
//   GA on all current models including claude-haiku-4-5. No beta header, and no
//   `as never` on the params: the SDK types `output_config` on
//   MessageCreateParamsNonStreaming and infers `parsed_output` from the schema
//   you pass. Casting the params away takes that inference with it — which is
//   how four call sites ended up hand-asserting their own response shapes.
//   `parsed_output` is `T | null`; every call site guards it.
//
// cache_control system-block array syntax:
//   system accepts TextBlockParam[] where each block may carry
//   cache_control: { type: 'ephemeral' } (default 5-min TTL) or
//   cache_control: { type: 'ephemeral', ttl: '1h' } (1-hour TTL).
//   Placement: breakpoint on the *last* block caches everything before it
//   (tools → system → messages render order).
//
//   Minimum cacheable prefix is 4096 tokens on Haiku 4.5 — high enough that
//   whether a breakpoint does anything is an empirical question per call site,
//   not a given. Measured in production: the chat call clears it (writes ~5k),
//   chat-parts and both suggest calls do not. See the comments on
//   `buildSystemBlocks` (lib/ai/prompts.ts) and the snapshot block in
//   lib/chat/parts-extract.ts, and check `AISuggestionLog.cacheReadTokens`
//   before assuming any of it has changed.
import Anthropic from '@anthropic-ai/sdk';
import { getEnv } from '@/lib/env';

let _client: Anthropic | undefined;

export function getAnthropic(): Anthropic {
  if (!_client) {
    _client = new Anthropic({
      apiKey: getEnv().ANTHROPIC_API_KEY,
      // Default timeout 30s — the spec's error matrix expects this.
      timeout: 30_000,
      // One SDK-level retry (429/5xx/connection errors), and nothing above it —
      // no call site adds an outer retry. Two attempts total, worst case ~60s.
      maxRetries: 1,
    });
  }
  return _client;
}

export const ANTHROPIC_MODEL = 'claude-haiku-4-5' as const;
export const ANTHROPIC_MAX_TOKENS = 2048;

// Chat turns return a reply plus up to several proposals carrying note bodies,
// which does not fit in ANTHROPIC_MAX_TOKENS. `messages.parse` throws on a
// truncated response, so an undersized ceiling loses the whole turn — which is
// exactly the large-dump case conversational capture exists to handle.
// Passed per call site; every existing caller keeps ANTHROPIC_MAX_TOKENS.
export const ANTHROPIC_CHAT_MAX_TOKENS = 4096;
