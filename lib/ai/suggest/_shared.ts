import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk';

export class ChecklistNotFoundError extends Error {
  constructor() {
    super('Checklist not found');
    this.name = 'ChecklistNotFoundError';
  }
}

/**
 * Why an Anthropic call failed, as the string persisted to
 * `AISuggestionLog.errorReason`.
 *
 * Three layers, in order, because each catches something the next cannot:
 *
 *  1. **SDK error classes.** The production path. Ordering inside this layer
 *     matters — `APIConnectionTimeoutError extends APIConnectionError`, so the
 *     subclass is checked first or every timeout reads as a generic network
 *     failure.
 *  2. **A numeric `status`.** Anything that carries a status but lost its
 *     prototype: a wrapper, a re-thrown plain object, the integration
 *     fixtures.
 *  3. **Message text.** Only for `ZodError` (the SDK's own `output_config`
 *     re-validation throws one of those, not an Anthropic error) and for
 *     timeouts raised outside the SDK.
 *
 * `auth_error` and `bad_request` were both `unknown` before this — an expired
 * API key and a malformed request produced the same log line and the same
 * user-facing message, which made the one failure a self-hoster can actually
 * fix indistinguishable from the one they cannot.
 */
export function classifyAnthropicError(e: unknown): string {
  // Layer 1 — typed SDK errors.
  if (e instanceof APIUserAbortError) return 'aborted';
  if (e instanceof APIConnectionTimeoutError) return 'timeout';
  if (e instanceof APIConnectionError) return 'network';
  if (e instanceof APIError) {
    // `type` distinguishes cases the status alone cannot: 529 overload from a
    // genuinely broken upstream, and billing from permissions on a 403.
    if (e.type === 'overloaded_error') return 'overloaded';
    const byStatus = classifyStatus(e.status);
    if (byStatus) return byStatus;
  }

  // Layer 2 — a status without an SDK prototype.
  const byStatus = classifyStatus((e as { status?: unknown })?.status);
  if (byStatus) return byStatus;

  // Layer 3 — shape and message text, for non-SDK throwers.
  //
  // `name`, not `instanceof z.ZodError`: the SDK re-validates `output_config`
  // responses against our schema, and if it ever resolves its own copy of zod
  // an `instanceof` check would fail against an error that is a ZodError in
  // every way that matters. Matching the name is copy-independent, and drops a
  // zod import from this module besides.
  if ((e as { name?: unknown })?.name === 'ZodError') return 'schema_violation';
  const msg = typeof (e as Error)?.message === 'string' ? (e as Error).message.toLowerCase() : '';
  if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
  if (msg.includes('aborted')) return 'aborted';
  if (msg.includes('zoderror') || msg.includes('schema')) return 'schema_violation';
  return 'unknown';
}

/**
 * Why a *successful* call is nonetheless unusable, from `stop_reason`.
 *
 * A 200 with `stop_reason: "max_tokens"` is a truncated answer, and one with
 * `"refusal"` is a safety decline; neither throws, so nothing in the error path
 * above ever sees them. Without this they surfaced as whatever downstream
 * parsing happened to do with a half-written document — `unparseable_json` on
 * the unconstrained parts call, a null `parsed_output` on the constrained ones
 * — which points the next reader at the model's JSON rather than at the token
 * ceiling that actually caused it.
 *
 * Returns null for the ordinary stop reasons, so callers can write
 * `classifyStopReason(res.stop_reason) ?? <their own fallback>`.
 */
export function classifyStopReason(stopReason: string | null | undefined): string | null {
  switch (stopReason) {
    case 'max_tokens':
      return 'truncated';
    case 'refusal':
      return 'refusal';
    default:
      return null;
  }
}

/** Shared by the typed and duck-typed layers so they cannot drift apart. */
function classifyStatus(status: unknown): string | null {
  if (typeof status !== 'number') return null;
  if (status === 429) return 'rate_limited'; // before the generic 4xx branch
  if (status === 529) return 'overloaded';
  if (status === 401 || status === 403) return 'auth_error';
  if (status >= 400 && status < 500) return 'bad_request';
  if (status >= 500 && status < 600) return 'upstream_5xx';
  return null;
}

export function userFacingMessage(reason: string): string {
  switch (reason) {
    case 'rate_limited':
    case 'overloaded':
      return 'Service busy — try again in a minute.';
    case 'upstream_5xx':
    case 'network':
      return "Couldn't reach AI service.";
    case 'timeout':
      return 'Took too long — try again.';
    case 'aborted':
      return 'Cancelled before it finished.';
    case 'schema_violation':
      return 'Got an unexpected response — try again.';
    case 'truncated':
      return 'The reply was cut off before it finished — try a shorter message.';
    case 'refusal':
      return 'The AI declined to answer that one.';
    case 'auth_error':
      // Single-tenant and self-hosted: whoever sees this is whoever can fix it.
      return 'The AI service rejected our credentials — check ANTHROPIC_API_KEY.';
    default:
      return 'Something went wrong generating suggestions.';
  }
}
