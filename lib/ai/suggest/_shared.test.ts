import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { classifyAnthropicError, classifyStopReason, userFacingMessage } from './_shared';

// The reason strings land in `AISuggestionLog.errorReason` and are the only
// forensic record of why a call failed. The suite below is deliberately split:
// real SDK error instances are the production path, and the duck-typed cases
// are the fallback that keeps older call sites (and the integration fixtures)
// classifying correctly.

const headers = new Headers();

describe('classifyAnthropicError — real SDK error instances', () => {
  it('classifies a 429 as rate_limited', () => {
    const e = new RateLimitError(429, { type: 'rate_limit_error' }, undefined, headers);
    expect(classifyAnthropicError(e)).toBe('rate_limited');
  });

  it('classifies a 500 as upstream_5xx', () => {
    const e = new InternalServerError(500, { type: 'api_error' }, undefined, headers);
    expect(classifyAnthropicError(e)).toBe('upstream_5xx');
  });

  it('separates a 529 overload from a generic 5xx', () => {
    // Same InternalServerError class, different `type` — 529 is transient
    // capacity, not a broken upstream, and it is worth telling apart when
    // reading the log after a bad afternoon.
    const e = new InternalServerError(529, { type: 'overloaded_error' }, undefined, headers);
    expect(classifyAnthropicError(e)).toBe('overloaded');
  });

  it('classifies a connection timeout as timeout', () => {
    expect(classifyAnthropicError(new APIConnectionTimeoutError())).toBe('timeout');
  });

  it('classifies a non-timeout connection failure as network', () => {
    // Subclass ordering matters: APIConnectionTimeoutError extends
    // APIConnectionError, so a check on the parent first would swallow every
    // timeout into `network`.
    expect(classifyAnthropicError(new APIConnectionError({ message: 'socket hang up' }))).toBe(
      'network',
    );
  });

  it('classifies a user abort as aborted', () => {
    expect(classifyAnthropicError(new APIUserAbortError())).toBe('aborted');
  });

  // The whole point of this change: 401 and 400 both used to land in
  // `unknown`, so an expired API key and a malformed request were the same
  // log line and the same user-facing message.
  it('classifies a 401 as auth_error', () => {
    const e = new AuthenticationError(401, { type: 'authentication_error' }, undefined, headers);
    expect(classifyAnthropicError(e)).toBe('auth_error');
  });

  it('classifies a 403 as auth_error', () => {
    const e = new PermissionDeniedError(403, { type: 'permission_error' }, undefined, headers);
    expect(classifyAnthropicError(e)).toBe('auth_error');
  });

  it('classifies a 400 as bad_request', () => {
    const e = new BadRequestError(400, { type: 'invalid_request_error' }, undefined, headers);
    expect(classifyAnthropicError(e)).toBe('bad_request');
  });

  it('classifies a 422 as bad_request', () => {
    const e = new UnprocessableEntityError(
      422,
      { type: 'invalid_request_error' },
      undefined,
      headers,
    );
    expect(classifyAnthropicError(e)).toBe('bad_request');
  });

  it('does not confuse a 400 with a 429', () => {
    // Guards the ordering of the status branches — a `>= 400` check placed
    // before the 429 branch would silently reclassify every rate limit.
    const bad = new BadRequestError(400, { type: 'invalid_request_error' }, undefined, headers);
    const limited = new RateLimitError(429, { type: 'rate_limit_error' }, undefined, headers);
    expect(classifyAnthropicError(bad)).not.toBe(classifyAnthropicError(limited));
  });
});

describe('classifyAnthropicError — schema failures', () => {
  it('classifies a ZodError as schema_violation', () => {
    // The SDK re-validates `output_config` responses with the schema we passed
    // and throws a real ZodError — not an Anthropic error class.
    const parsed = z.object({ a: z.string() }).safeParse({ a: 1 });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('expected a parse failure');
    expect(classifyAnthropicError(parsed.error)).toBe('schema_violation');
  });
});

describe('classifyAnthropicError — duck-typed fallbacks', () => {
  // Not hypothetical: the AI integration fixtures throw plain Errors carrying
  // a `status`, and so would any wrapper that loses the prototype chain.
  function statusError(status: number) {
    return Object.assign(new Error('x'), { status });
  }

  it('falls back to a numeric status when the prototype is not an SDK class', () => {
    expect(classifyAnthropicError(statusError(429))).toBe('rate_limited');
    expect(classifyAnthropicError(statusError(503))).toBe('upstream_5xx');
    expect(classifyAnthropicError(statusError(401))).toBe('auth_error');
    expect(classifyAnthropicError(statusError(400))).toBe('bad_request');
  });

  it('still recognises timeout and schema wording in a bare Error', () => {
    expect(classifyAnthropicError(new Error('Request timed out'))).toBe('timeout');
    expect(classifyAnthropicError(new Error('The operation was aborted'))).toBe('aborted');
    expect(classifyAnthropicError(new Error('ZodError: invalid input'))).toBe('schema_violation');
  });

  it('returns unknown for anything it cannot place', () => {
    expect(classifyAnthropicError(new Error('something odd'))).toBe('unknown');
    expect(classifyAnthropicError(null)).toBe('unknown');
    expect(classifyAnthropicError(undefined)).toBe('unknown');
    expect(classifyAnthropicError('a string')).toBe('unknown');
  });
});

describe('classifyStopReason', () => {
  // A 200 response can still be a failure. Both of these arrive as a normal
  // result the caller has to notice, and before this they were indistinguishable
  // from "the model emitted garbage".
  it('names a truncated response', () => {
    expect(classifyStopReason('max_tokens')).toBe('truncated');
  });

  it('names a refusal', () => {
    expect(classifyStopReason('refusal')).toBe('refusal');
  });

  it('returns null for the ordinary stop reasons', () => {
    for (const r of ['end_turn', 'stop_sequence', 'tool_use', 'pause_turn', null, undefined]) {
      expect(classifyStopReason(r), String(r)).toBeNull();
    }
  });
});

describe('userFacingMessage', () => {
  it('has a message for every reason the classifier can produce', () => {
    const reasons = [
      'rate_limited',
      'overloaded',
      'upstream_5xx',
      'timeout',
      'network',
      'aborted',
      'auth_error',
      'bad_request',
      'schema_violation',
      'truncated',
      'refusal',
      'unknown',
    ];
    for (const r of reasons) {
      expect(userFacingMessage(r), r).toBeTruthy();
    }
  });

  it('tells a self-hoster that an auth failure is theirs to fix', () => {
    // This app is single-tenant and self-hosted: the person seeing the error
    // is the person who can go fix the key. A generic "something went wrong"
    // wastes that.
    expect(userFacingMessage('auth_error')).toMatch(/key|configur/i);
  });

  it('does not leak an internal reason string into the UI', () => {
    for (const r of ['bad_request', 'schema_violation', 'truncated', 'refusal', 'unknown']) {
      expect(userFacingMessage(r)).not.toContain('_');
    }
  });
});
