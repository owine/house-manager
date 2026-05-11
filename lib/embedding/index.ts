import { createHash } from 'node:crypto';
import type { EmbeddingEntityType } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getLogger } from '@/lib/logger';
import {
  canonicalizeAttachment,
  canonicalizeChecklistItem,
  canonicalizeItem,
  canonicalizeNote,
  canonicalizeServiceRecord,
  canonicalizeWarranty,
} from './canonicalize';
import { chunkText, estimateTokens } from './chunk';
import { embedTexts, VOYAGE_DIMENSIONS } from './voyage';

const log = getLogger('embedding.orchestrator');

export type EmbedEntityOptions = {
  /** When true, replace existing rows even if the content hash matches. */
  force?: boolean;
};

export type EmbedEntityResult = {
  status: 'embedded' | 'unchanged' | 'deleted' | 'skipped';
  chunkCount?: number;
};

/**
 * Build canonical text, embed it via Voyage, and upsert the resulting
 * chunks into the `embeddings` table for one entity. Idempotent: if the
 * canonical-text SHA-256 hash matches what's already stored, the call is
 * a no-op and returns `{ status: 'unchanged' }` (unless `force: true`).
 *
 * When an entity row doesn't exist (or is archived, where archive semantics
 * tell us to drop embeddings), this clears any orphan rows and returns
 * `{ status: 'deleted' }`.
 *
 * All vector writes go through `$executeRaw` with an explicit `::vector(1024)`
 * cast because Prisma's `Unsupported` type can't be the target of a
 * `createMany`. The transaction wraps the delete + per-chunk insert so a
 * partial failure doesn't leave stale rows.
 */
export async function embedEntity(
  entityType: EmbeddingEntityType,
  entityId: string,
  opts: EmbedEntityOptions = {},
): Promise<EmbedEntityResult> {
  const canonical = await buildCanonical(entityType, entityId);

  // Deleted / archived / unknown entity → wipe its embeddings.
  if (canonical === null) {
    const deleted = await prisma.embedding.deleteMany({
      where: { entityType, entityId },
    });
    if (deleted.count > 0) {
      log.info({ entityType, entityId, count: deleted.count }, 'embed: tombstoned');
    }
    return { status: 'deleted' };
  }

  if (canonical.trim().length === 0) {
    // Nothing useful to embed — equivalent to a tombstone.
    await prisma.embedding.deleteMany({ where: { entityType, entityId } });
    return { status: 'skipped' };
  }

  const contentHash = sha256(canonical);

  if (!opts.force) {
    const existing = await prisma.embedding.findFirst({
      where: { entityType, entityId },
      select: { contentHash: true },
    });
    if (existing && existing.contentHash === contentHash) {
      return { status: 'unchanged' };
    }
  }

  const chunks = chunkText(canonical);
  if (chunks.length === 0) {
    await prisma.embedding.deleteMany({ where: { entityType, entityId } });
    return { status: 'skipped' };
  }

  const embeddings = await embedTexts(chunks, { inputType: 'document' });
  if (embeddings.length !== chunks.length) {
    throw new Error(`Voyage returned ${embeddings.length} embeddings for ${chunks.length} chunks`);
  }
  for (const emb of embeddings) {
    if (emb.length !== VOYAGE_DIMENSIONS) {
      throw new Error(`Voyage returned ${emb.length}-dim embedding; expected ${VOYAGE_DIMENSIONS}`);
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.embedding.deleteMany({ where: { entityType, entityId } });
    for (const [i, text] of chunks.entries()) {
      const emb = embeddings[i];
      if (!emb) throw new Error(`missing embedding at index ${i}`);
      const id = cuid();
      const vectorLiteral = `[${Array.from(emb).join(',')}]`;
      await tx.$executeRaw`
        INSERT INTO embeddings (id, "entityType", "entityId", "chunkIndex", text, embedding, "tokenCount", "contentHash", "createdAt")
        VALUES (${id}, ${entityType}::"EmbeddingEntityType", ${entityId}, ${i}, ${text}, ${vectorLiteral}::vector(1024), ${estimateTokens(text)}, ${contentHash}, NOW())
      `;
    }
  });

  log.info(
    { entityType, entityId, chunkCount: chunks.length, totalChars: canonical.length },
    'embed: stored',
  );
  return { status: 'embedded', chunkCount: chunks.length };
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// Minimal cuid-ish ID generator for inserted rows. Using crypto.randomUUID
// would also work but keeps the existing cuid-style id format consistent
// with the rest of the schema. Prisma's default `cuid()` runs in the
// client at insert time but `$executeRaw` bypasses that.
function cuid(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `c${t}${r}`;
}

async function buildCanonical(
  entityType: EmbeddingEntityType,
  entityId: string,
): Promise<string | null> {
  switch (entityType) {
    case 'ITEM': {
      const item = await prisma.item.findUnique({
        where: { id: entityId },
        select: {
          name: true,
          archivedAt: true,
          location: true,
          manufacturer: true,
          model: true,
          purchaseDate: true,
          purchasePrice: true,
          metadata: true,
          notes: true,
          category: { select: { name: true } },
          system: { select: { name: true } },
        },
      });
      if (!item || item.archivedAt) return null;
      return canonicalizeItem({
        name: item.name,
        category: item.category,
        system: item.system,
        location: item.location,
        manufacturer: item.manufacturer,
        model: item.model,
        purchaseDate: item.purchaseDate,
        purchasePrice: item.purchasePrice as unknown as number | string | null,
        metadata: (item.metadata as Record<string, unknown>) ?? {},
        notes: item.notes,
      });
    }
    case 'NOTE': {
      const note = await prisma.note.findUnique({
        where: { id: entityId },
        select: {
          title: true,
          body: true,
          createdAt: true,
          item: { select: { name: true } },
        },
      });
      if (!note) return null;
      const parent = note.item != null ? { kind: 'item' as const, name: note.item.name } : null;
      return canonicalizeNote({
        title: note.title,
        body: note.body,
        parent,
        createdAt: note.createdAt,
      });
    }
    case 'SERVICE_RECORD': {
      const sr = await prisma.serviceRecord.findUnique({
        where: { id: entityId },
        select: {
          summary: true,
          performedOn: true,
          cost: true,
          notes: true,
          vendor: { select: { name: true } },
          targets: {
            select: {
              item: { select: { name: true } },
              system: { select: { name: true } },
            },
          },
        },
      });
      if (!sr) return null;
      return canonicalizeServiceRecord({
        summary: sr.summary,
        performedOn: sr.performedOn,
        cost: sr.cost as unknown as number | string | null,
        notes: sr.notes,
        vendor: sr.vendor,
        targets: sr.targets,
      });
    }
    case 'CHECKLIST_ITEM': {
      const ci = await prisma.checklistItem.findUnique({
        where: { id: entityId },
        select: {
          title: true,
          rationale: true,
          completedAt: true,
          checklist: { select: { name: true } },
          item: { select: { name: true } },
        },
      });
      if (!ci) return null;
      return canonicalizeChecklistItem({
        title: ci.title,
        rationale: ci.rationale,
        completed: ci.completedAt !== null,
        checklist: ci.checklist,
        item: ci.item,
      });
    }
    case 'WARRANTY': {
      const w = await prisma.warranty.findUnique({
        where: { id: entityId },
        select: {
          provider: true,
          policyNumber: true,
          coverage: true,
          startsOn: true,
          endsOn: true,
          cost: true,
          targets: {
            select: {
              item: { select: { name: true } },
              system: { select: { name: true } },
            },
          },
        },
      });
      if (!w) return null;
      return canonicalizeWarranty({
        provider: w.provider,
        policyNumber: w.policyNumber,
        coverage: w.coverage,
        startsOn: w.startsOn,
        endsOn: w.endsOn,
        cost: w.cost as unknown as number | string | null,
        targets: w.targets,
      });
    }
    case 'ATTACHMENT': {
      const a = await prisma.attachment.findUnique({
        where: { id: entityId },
        select: {
          filename: true,
          extractedText: true,
          aiIndexable: true,
          item: { select: { name: true } },
          warranty: { select: { provider: true } },
          serviceRecord: { select: { summary: true } },
          note: { select: { title: true } },
        },
      });
      if (!a) return null;
      if (a.aiIndexable === false) return null; // user opted out
      const parent =
        a.item != null
          ? { kind: 'item', name: a.item.name }
          : a.serviceRecord != null
            ? { kind: 'serviceRecord', name: a.serviceRecord.summary }
            : a.warranty != null
              ? { kind: 'warranty', name: a.warranty.provider }
              : a.note != null
                ? { kind: 'note', name: a.note.title }
                : null;
      return canonicalizeAttachment({
        filename: a.filename,
        extractedText: a.extractedText,
        parent,
      });
    }
    default: {
      const _exhaustive: never = entityType;
      throw new Error(`Unknown EmbeddingEntityType: ${_exhaustive}`);
    }
  }
}
