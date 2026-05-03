import { prisma } from '@/lib/db';

export const RATE_LIMIT_PER_HOUR = 10;

export type RateLimitCheck = {
  allowed: boolean;
  used: number;
  remaining: number;
  windowResetsAt: Date;
};

export async function checkRateLimit(userId: string): Promise<RateLimitCheck> {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const used = await prisma.aISuggestionLog.count({
    where: { userId, createdAt: { gte: since } },
  });
  const remaining = Math.max(0, RATE_LIMIT_PER_HOUR - used);
  return {
    allowed: used < RATE_LIMIT_PER_HOUR,
    used,
    remaining,
    windowResetsAt: new Date(since.getTime() + 60 * 60 * 1000),
  };
}
