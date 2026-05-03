import { prisma } from '@/lib/db';

export async function listChecklists() {
  return prisma.checklist.findMany({
    where: { active: true },
    orderBy: { updatedAt: 'desc' },
    include: { _count: { select: { items: true } } },
  });
}

export async function getChecklist(id: string) {
  return prisma.checklist.findUnique({
    where: { id },
    include: {
      items: {
        orderBy: { position: 'asc' },
        include: { item: { select: { id: true, name: true } } },
      },
    },
  });
}
