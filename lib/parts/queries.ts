import type { PartKind, Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';
import type { ListParams } from '@/lib/url-params';
import { PART_KINDS } from './schema';

/**
 * A part is treated as **archived wherever all of its parents are archived** —
 * derived, never stored. Nothing is written when a parent is archived, so
 * nothing can drift, and restoring the parent brings the part back for free.
 * `Part.archivedAt` remains independent, for "I stopped buying this bulb while
 * keeping the fixture".
 *
 * Live = not itself archived AND (no links at all — the generic-bulbs case — OR
 * at least one link to a live parent).
 *
 * A link row with `itemId` NULL and a live `systemId` resolves correctly:
 * `{ item: { archivedAt: null } }` compiles to an EXISTS-based filter that is
 * false rather than vacuously true, and the `system` disjunct carries the row.
 *
 * Exported so the rule is written once — a second inline copy is exactly how
 * the list page and the target picker end up disagreeing.
 */
export const LIVE_PART = {
  archivedAt: null,
  OR: [
    { links: { none: {} } },
    { links: { some: { OR: [{ item: { archivedAt: null } }, { system: { archivedAt: null } }] } } },
  ],
} satisfies Prisma.PartWhereInput;

/**
 * The exact negation of {@link LIVE_PART}, backing the `/parts` archived filter.
 * Note it is *not* simply `archivedAt: { not: null }`: a live part all of whose
 * parents are archived belongs here too.
 */
export const ARCHIVED_PART = {
  OR: [
    { archivedAt: { not: null } },
    {
      AND: [
        { links: { some: {} } },
        {
          links: {
            none: { OR: [{ item: { archivedAt: null } }, { system: { archivedAt: null } }] },
          },
        },
      ],
    },
  ],
} satisfies Prisma.PartWhereInput;

export async function listParts(params: ListParams) {
  const showArchived = params.filters.archived?.includes('true') ?? false;
  const kinds = (params.filters.kind ?? []).filter((k): k is PartKind =>
    (PART_KINDS as readonly string[]).includes(k),
  );

  const where: Prisma.PartWhereInput = {
    AND: [
      showArchived ? ARCHIVED_PART : LIVE_PART,
      params.q
        ? {
            OR: [
              { name: { contains: params.q, mode: 'insensitive' as const } },
              { manufacturer: { contains: params.q, mode: 'insensitive' as const } },
              { model: { contains: params.q, mode: 'insensitive' as const } },
              { sku: { contains: params.q, mode: 'insensitive' as const } },
            ],
          }
        : {},
      // Query-string values are untrusted text; narrow them to real enum
      // members rather than handing Postgres an unknown enum label.
      kinds.length ? { kind: { in: kinds } } : {},
      params.filters.item?.length
        ? { links: { some: { itemId: { in: params.filters.item } } } }
        : {},
      params.filters.system?.length
        ? { links: { some: { systemId: { in: params.filters.system } } } }
        : {},
    ],
  };

  const orderBy =
    params.sort === 'createdAt' ? { createdAt: 'desc' as const } : { name: 'asc' as const };

  const [parts, total] = await Promise.all([
    prisma.part.findMany({
      where,
      orderBy,
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
      include: {
        links: {
          include: {
            item: { select: { id: true, name: true, archivedAt: true } },
            system: { select: { id: true, name: true, archivedAt: true } },
          },
        },
        _count: {
          select: { reminderTargets: true, serviceRecordTargets: true, attachments: true },
        },
      },
    }),
    prisma.part.count({ where }),
  ]);

  return { parts, total };
}

export async function getPart(id: string) {
  return prisma.part.findUnique({
    where: { id },
    include: {
      links: {
        orderBy: { createdAt: 'asc' },
        include: {
          item: { select: { id: true, name: true, archivedAt: true } },
          system: { select: { id: true, name: true, archivedAt: true } },
        },
      },
      reminderTargets: {
        orderBy: { nextDueOn: 'asc' },
        select: {
          id: true,
          nextDueOn: true,
          reminder: { select: { id: true, title: true, kind: true, active: true } },
        },
      },
      serviceRecordTargets: {
        orderBy: { serviceRecord: { performedOn: 'desc' } },
        include: {
          serviceRecord: { include: { vendor: { select: { id: true, name: true } } } },
        },
      },
      attachments: {
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          filename: true,
          mimeType: true,
          sizeBytes: true,
          storagePath: true,
          externalUrl: true,
          displayLabel: true,
          thumbnailPath: true,
        },
      },
    },
  });
}

/**
 * Live parts projected to the shape consumed by `<TargetsPicker>`, mirroring
 * `listAllActiveItemsForPicker()` / `listSystemsWithItemsForPicker()`.
 */
export async function listPartsForPicker() {
  const rows = await prisma.part.findMany({
    where: LIVE_PART,
    orderBy: { name: 'asc' },
    select: { id: true, name: true, kind: true, archivedAt: true },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    archivedAt: r.archivedAt,
  }));
}
