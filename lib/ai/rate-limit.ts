import { prisma } from '@/lib/db';
import type { SuggestionKind } from './log';

// Budgets are scoped per `kind` rather than shared across every AI feature —
// this deliberately raised the aggregate ceiling a user can hit per hour
// (each kind now gets its own budget instead of competing for one shared
// bucket). See docs/superpowers/specs/2026-07-26-conversational-capture-design.md
// (Task 2) for the rationale, and the now-superseded claim it replaces in
// docs/superpowers/specs/2026-05-10-plan-4c-ask-design.md.

const HOUR_MS = 60 * 60 * 1000;

/** Default budget for one-shot AI kinds. */
export const RATE_LIMIT_PER_HOUR = 10;

// Per-kind hourly budgets. A capture conversation burns 3-4 turns on a single
// task, so chat gets a larger allowance than the one-shot kinds.
//
// `AISuggestionLog.kind` is a String column, not an enum, so this map is
// intentionally kept `Record<string, number>` (not a total record over
// `SuggestionKind`) as defence-in-depth against a stray runtime string —
// the `?? RATE_LIMIT_PER_HOUR` fallback below must never be removed. Type
// safety instead lives at the `checkRateLimit`/`limitForKind` parameter,
// which is compile-time checked against `SuggestionKind`.
const LIMITS: Record<string, number> = {
  chat: 40,
};

export function limitForKind(kind: SuggestionKind): number {
  return LIMITS[kind] ?? RATE_LIMIT_PER_HOUR;
}

export type RateLimitCheck = {
  allowed: boolean;
  used: number;
  remaining: number;
  limit: number;
};

export async function checkRateLimit(
  userId: string,
  kind: SuggestionKind,
): Promise<RateLimitCheck> {
  const since = new Date(Date.now() - HOUR_MS);
  const limit = limitForKind(kind);
  const used = await prisma.aISuggestionLog.count({
    where: { userId, kind, createdAt: { gte: since } },
  });
  return {
    allowed: used < limit,
    used,
    remaining: Math.max(0, limit - used),
    limit,
  };
}
