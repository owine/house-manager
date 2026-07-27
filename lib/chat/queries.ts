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
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          role: true,
          content: true,
          createdAt: true,
          proposals: {
            orderBy: { createdAt: 'asc' },
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
