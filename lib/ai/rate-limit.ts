import { prisma } from '@/lib/db';

export const RATE_LIMIT_PER_HOUR = 10;

const HOUR_MS = 60 * 60 * 1000;

export type RateLimitCheck = {
  allowed: boolean;
  used: number;
  remaining: number;
};

export async function checkRateLimit(userId: string): Promise<RateLimitCheck> {
  const since = new Date(Date.now() - HOUR_MS);
  const used = await prisma.aISuggestionLog.count({
    where: { userId, createdAt: { gte: since } },
  });
  const remaining = Math.max(0, RATE_LIMIT_PER_HOUR - used);
  return {
    allowed: used < RATE_LIMIT_PER_HOUR,
    used,
    remaining,
  };
}
