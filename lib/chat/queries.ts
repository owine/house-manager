import { prisma } from '@/lib/db';

/**
 * One session with its full thread. Returns null when the session does not
 * exist OR belongs to another user — callers must not distinguish the two.
 */
export async function getChatSession(id: string, userId: string) {
  const session = await prisma.chatSession.findFirst({
    where: { id, userId },
    select: {
      id: true,
      title: true,
      messages: {
        // `id` breaks createdAt ties, and ties are the norm, not an edge: a
        // turn's USER and ASSISTANT rows are written in one transaction, so
        // they share a millisecond about a third of the time (and always, from
        // a nested create). Without it the pair's order is whatever Postgres
        // happens to return. cuid() ids are timestamp + per-process counter,
        // so they ascend in creation order.
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          role: true,
          content: true,
          createdAt: true,
          proposals: {
            // Same tie-break: a message's proposals come from one nested create.
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              kind: true,
              targetType: true,
              targetId: true,
              payload: true,
              status: true,
              baseUpdatedAt: true,
              // Required — this is the "before" half of every update-kind
              // diff. Omitting it renders every card with an empty before.
              beforeSnapshot: true,
              appliedEntityId: true,
            },
          },
        },
      },
    },
  });
  return session;
}
