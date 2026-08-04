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
      timeout: DEFAULT_TIMEOUT_MS,
      // One SDK-level retry (429/5xx/connection errors), and nothing above it —
      // no call site adds an outer retry. Two attempts total.
      //
      // Note this interacts with `timeout`: a request that exceeds the timeout
      // is *retried*, so a too-tight timeout does not fail fast — it silently
      // doubles the cost of a slow call. See ANTHROPIC_CHAT_TIMEOUT_MS.
      maxRetries: 1,
    });
  }
  return _client;
}

/**
 * Client-wide request timeout. Fits every call site measured in production
 * except chat — suggest calls run 6–11s average and 15s worst, and the
 * PDF-bearing email classify runs ~11s average, 12.4s worst.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Per-request override for the chat turn, which is the one call that outgrows
 * the default.
 *
 * Production has a successful chat turn at 52.6s wall clock against a 30s
 * timeout. That is only possible via the SDK's retry: the first attempt was cut
 * off at 30s, the second succeeded, and our `Date.now() - start` spans both. So
 * the tight timeout did not fail that turn fast — it made the user wait longer
 * AND paid for two model calls. Chat is the natural outlier: the largest
 * `max_tokens` of any call site, plus a second model call racing alongside it.
 *
 * Sized to sit above the observed worst case rather than at it, so an ordinary
 * slow turn completes on the first attempt and the retry goes back to covering
 * what it is for — 429s, 5xx, and dropped connections.
 */
export const ANTHROPIC_CHAT_TIMEOUT_MS = 90_000;

export const ANTHROPIC_MODEL = 'claude-haiku-4-5' as const;
export const ANTHROPIC_MAX_TOKENS = 2048;

// Chat turns return a reply plus up to several proposals carrying note bodies,
// which does not fit in ANTHROPIC_MAX_TOKENS. `messages.parse` throws on a
// truncated response, so an undersized ceiling loses the whole turn — which is
// exactly the large-dump case conversational capture exists to handle.
// Passed per call site; every existing caller keeps ANTHROPIC_MAX_TOKENS.
export const ANTHROPIC_CHAT_MAX_TOKENS = 4096;
