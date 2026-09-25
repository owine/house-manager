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
  //
  // The leading `(?<![a-z0-9+.-])`, not just `\b`, matters for more than
  // correctness: without it this is QUADRATIC on adversarial input. `\b`
  // still lets the engine attempt a match starting at every position inside
  // a long run of scheme-charset characters that never resolves to "://"
  // (e.g. a log line that's mostly dots or pluses), and each attempt
  // re-scans the rest of the run before failing — O(n) attempts * O(n) scan
  // each. Confirmed: 'a.'.repeat(50_000) took ~8s before this, <1ms after.
  // The regex still matches every real credentialed URL the same way (see
  // lib/log-scrub.test.ts's equivalence cases).
  [/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s:/?#@]+:)[^\s@/]+(@)/gi, '$1***$2'],
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
 *
 * `seen` tracks the current recursion ANCESTRY, not "every object visited
 * ever": a value is added right before recursing into its children and
 * removed right after (try/finally), so a true cycle (a value that is its
 * own ancestor) still resolves to `[Circular]`, but the same array or object
 * reachable twice from unrelated branches — `{ ids, again: ids }`, or two log
 * fields sharing one array — is walked twice and keeps its content both
 * times instead of the second occurrence collapsing to `[Circular]`.
 */
export function deepScrubStrings(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return scrubSecrets(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    try {
      return value.map((v) => deepScrubStrings(v, seen));
    } finally {
      seen.delete(value);
    }
  }
  if (value instanceof Error) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    try {
      return scrubObject(errorFields(value), seen);
    } finally {
      seen.delete(value);
    }
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    try {
      return scrubObject(value, seen);
    } finally {
      seen.delete(value);
    }
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
