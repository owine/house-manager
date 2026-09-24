import { type EmbeddingEntityType, Prisma } from '@prisma/client';

/**
 * Is the source of an `embeddings` row still something Ask may answer from?
 *
 * `embeddings` is polymorphic (entityType + entityId, no FK), so no cascade ever
 * reaches it. Deleting a note, a checklist or an attachment's parent leaves its
 * chunks behind, and those chunks used to flow straight into the chat prompt
 * (Q-H2). This predicate is the one definition of "live", shared by retrieval
 * (keep where true) and the embed.backfill orphan sweep (delete where false).
 * It must agree with `buildCanonical` in ./index.ts: the rows that function
 * returns null for are exactly the rows that are not live here.
 *   - ITEM / PART: the row exists and is not archived
 *   - ATTACHMENT: the row exists and aiIndexable (the user's opt-out)
 *   - everything else: the row exists
 *
 * It is a Record over the enum, so adding an EmbeddingEntityType fails typecheck
 * here until it gets a rule. That makes the ELSE unreachable. It is `true` so
 * that, if it ever were reached, the sweep would keep rows rather than delete
 * what it cannot judge.
 *
 * Callers must alias the embeddings row as `e`. ChecklistItem has no @@map, so
 * its table keeps Prisma's quoted PascalCase name.
 */
const SOURCE_IS_LIVE: Record<EmbeddingEntityType, Prisma.Sql> = {
  ITEM: Prisma.sql`EXISTS (SELECT 1 FROM items s WHERE s.id = e."entityId" AND s."archivedAt" IS NULL)`,
  NOTE: Prisma.sql`EXISTS (SELECT 1 FROM notes s WHERE s.id = e."entityId")`,
  SERVICE_RECORD: Prisma.sql`EXISTS (SELECT 1 FROM service_records s WHERE s.id = e."entityId")`,
  CHECKLIST_ITEM: Prisma.sql`EXISTS (SELECT 1 FROM "ChecklistItem" s WHERE s.id = e."entityId")`,
  WARRANTY: Prisma.sql`EXISTS (SELECT 1 FROM warranties s WHERE s.id = e."entityId")`,
  ATTACHMENT: Prisma.sql`EXISTS (SELECT 1 FROM attachments s WHERE s.id = e."entityId" AND s."aiIndexable" = true)`,
  PART: Prisma.sql`EXISTS (SELECT 1 FROM parts s WHERE s.id = e."entityId" AND s."archivedAt" IS NULL)`,
};

export const LIVE_SOURCE_SQL: Prisma.Sql = Prisma.sql`(CASE e."entityType" ${Prisma.join(
  (Object.keys(SOURCE_IS_LIVE) as EmbeddingEntityType[]).map(
    (type) => Prisma.sql`WHEN ${type}::"EmbeddingEntityType" THEN ${SOURCE_IS_LIVE[type]}`,
  ),
  ' ',
)} ELSE true END)`;
