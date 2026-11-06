import { prisma } from '@/lib/db';
import type { SuggestionKind } from './log';
import { SYSTEM_PROMPT_VERSION } from './prompts';

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
// safety instead lives at the `reserveRateLimit`/`limitForKind` parameter,
// which is compile-time checked against `SuggestionKind`.
const LIMITS: Record<string, number> = {
  chat: 40,
};

export function limitForKind(kind: SuggestionKind): number {
  return LIMITS[kind] ?? RATE_LIMIT_PER_HOUR;
}

export type RateLimitReservation = {
  allowed: boolean;
  used: number;
  remaining: number;
  limit: number;
  /**
   * The `in_flight` AISuggestionLog row holding this call's budget slot, or
   * null when refused. Pass it to `createSuggestionLog` as `reservationId`, so
   * the outcome fills in the reserved row instead of writing a second one.
   */
  reservationId: string | null;
};

/** `errorReason` on a reserved row whose call has not reported back yet. */
export const IN_FLIGHT = 'in_flight';

/**
 * Check the hourly budget and, when there is room, take a slot in it.
 *
 * Counting and consuming used to be separate: the count ran first and the row
 * that consumed budget was written after the model call returned, so N
 * overlapping requests all saw the same count and all got a paid call. Here the
 * count and the reservation commit together under a transaction-scoped advisory
 * lock keyed on user + kind, so a second request waits for the first's row and
 * counts it.
 *
 * A reservation whose caller dies before reporting stays `in_flight` and keeps
 * counting for the hour. That is the fail-safe direction.
 */
export async function reserveRateLimit(
  userId: string,
  kind: SuggestionKind,
  model: string,
): Promise<RateLimitReservation> {
  const since = new Date(Date.now() - HOUR_MS);
  const limit = limitForKind(kind);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ai-budget:${userId}:${kind}`}))`;
    const used = await tx.aISuggestionLog.count({
      where: { userId, kind, createdAt: { gte: since } },
    });
    if (used >= limit) {
      return { allowed: false, used, remaining: 0, limit, reservationId: null };
    }
    const row = await tx.aISuggestionLog.create({
      data: {
        userId,
        kind,
        systemPromptVersion: SYSTEM_PROMPT_VERSION,
        model,
        inventorySnapshotIds: [],
        errorReason: IN_FLIGHT,
      },
      select: { id: true },
    });
    return {
      allowed: true,
      used: used + 1,
      remaining: Math.max(0, limit - used - 1),
      limit,
      reservationId: row.id,
    };
  });
}

/**
 * Give back a reservation whose call will not happen (for example a re-run
 * that pg-boss deduplicated), so the member is not charged for nothing.
 */
export async function releaseReservation(reservationId: string): Promise<void> {
  await prisma.aISuggestionLog.deleteMany({
    where: { id: reservationId, errorReason: IN_FLIGHT },
  });
}
