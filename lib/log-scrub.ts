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
  // Capability tokens in the two public token-scoped routes. The path segment
  // IS the credential (the calendar feed's icsToken, the inbound webhook's
  // token), and request paths reach error reports via onRequestError.
  [/(\/api\/(?:calendar|inbound-email)\/)[^\s/?#"']+/g, '$1***'],
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
  if (value instanceof Error) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    return scrubObject(errorFields(value), seen);
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    return scrubObject(value, seen);
  }
  return value;
}

function scrubObject(value: object, seen: WeakSet<object>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = deepScrubStrings(v, seen);
  }
  return out;
}

/**
 * An Error's `message` and `stack` are own but NON-enumerable, so walking it
 * like a plain object yields only its custom fields (`code`, `cmd`, ...).
 * pino runs `formatters.log` (which calls deepScrubStrings) BEFORE the `err`
 * serializer, so without this every logged `{ err }` reached stdout as `{}`
 * plus custom fields: no message, no stack. Same shape as pino's own
 * stdSerializers.err (`type`, `message`, `stack`, then custom fields), plus a
 * nested `cause`.
 */
function errorFields(err: Error): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: err.constructor?.name ?? err.name,
    message: err.message,
    stack: err.stack,
  };
  for (const [k, v] of Object.entries(err)) out[k] = v;
  if (err.cause !== undefined) out.cause = err.cause;
  if (err instanceof AggregateError) out.aggregateErrors = err.errors;
  return out;
}
