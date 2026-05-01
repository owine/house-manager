import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';

export async function getCurrentUserSettings() {
  const session = await auth();
  if (!session?.user?.id) return null;

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      notificationPrefs: true,
      icsToken: true,
      pushSubscriptions: {
        select: {
          id: true,
          userAgent: true,
          createdAt: true,
        },
      },
    },
  });

  return user;
}
