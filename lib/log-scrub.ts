// Secret-scrubbing for log output. Pino's path-based `redact` blanks whole
// fields by key (e.g. `*.password`), but it cannot touch a secret embedded
// INSIDE a string value — which is how credentials actually leak (a DB
// connection string inside an error's `spawnargs`, a token in a message, etc.).
// These helpers scrub by PATTERN so embedded secrets are masked regardless of
// where they appear.

/** [pattern, replacement] pairs applied to every scrubbed string. */
const PATTERNS: Array<readonly [RegExp, string]> = [
  // URI userinfo password — scheme://user:PASSWORD@host → keep scheme+user, mask pw.
  // Covers postgresql://, redis://, amqp://, mongodb://, https:// with basic auth, etc.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/?#@]+:)[^\s@/]+(@)/gi, '$1***$2'],
  // PGPASSWORD=... (and similar PG*PASSWORD) in a command/env string.
  [/\b(PG[A-Z]*PASSWORD=)\S+/g, '$1***'],
  // Authorization headers: Bearer / Basic <token>.
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, '$1 ***'],
  // Anthropic / OpenAI-style API keys (sk-…, sk-ant-…).
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}/g, 'sk-***'],
];

/** Mask known secret patterns embedded anywhere in a string. */
export function scrubSecrets(input: string): string {
  let out = input;
  for (const [re, repl] of PATTERNS) out = out.replace(re, repl);
  return out;
}

/**
 * Recursively scrub secret patterns from every string within a value (objects,
 * arrays, nested). Non-strings pass through. Cycle-safe. Returns a scrubbed
 * copy — callers (the pino serializer/formatter) get a fresh object, the
 * original log payload is untouched.
 */
export function deepScrubStrings(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return scrubSecrets(value);
  if (Array.isArray(value)) return value.map((v) => deepScrubStrings(v, seen));
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = deepScrubStrings(v, seen);
    }
    return out;
  }
  return value;
}
