import { prisma } from '@/lib/db';

const HOUR_MS = 60 * 60 * 1000;

/** Default budget for one-shot AI kinds. */
export const RATE_LIMIT_PER_HOUR = 10;

// Per-kind hourly budgets. A capture conversation burns 3-4 turns on a single
// task, so chat gets a larger allowance than the one-shot kinds.
//
// `AISuggestionLog.kind` is a String column, not an enum, so this map is
// stringly-typed and MUST have a default for unknown kinds.
const LIMITS: Record<string, number> = {
  chat: 40,
};

export function limitForKind(kind: string): number {
  return LIMITS[kind] ?? RATE_LIMIT_PER_HOUR;
}

export type RateLimitCheck = {
  allowed: boolean;
  used: number;
  remaining: number;
  limit: number;
};

export async function checkRateLimit(userId: string, kind: string): Promise<RateLimitCheck> {
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
