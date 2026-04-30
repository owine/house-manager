// NOTE: Prisma returns `tags` as string[] natively on PostgreSQL arrays. No coercion needed.
import { prisma } from '@/lib/db';
import type { ListParams } from '@/lib/url-params';

export async function listNotes(params: ListParams) {
  const itemId = params.filters.itemId?.[0];

  const where = {
    AND: [
      itemId ? { itemId } : {},
      params.q
        ? {
            OR: [
              { title: { contains: params.q, mode: 'insensitive' as const } },
              { body: { contains: params.q, mode: 'insensitive' as const } },
            ],
          }
        : {},
    ],
  };

  const [notes, total] = await Promise.all([
    prisma.note.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
      include: {
        item: { select: { id: true, name: true } },
      },
    }),
    prisma.note.count({ where }),
  ]);

  return { notes, total };
}

export async function getNote(id: string) {
  return prisma.note.findUnique({
    where: { id },
    include: {
      item: { select: { id: true, name: true } },
      attachments: {
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          filename: true,
          mimeType: true,
          sizeBytes: true,
          thumbnailPath: true,
        },
      },
    },
  });
}

export async function listAllItemsForAutocomplete() {
  return prisma.item.findMany({
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
}
