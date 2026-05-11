import type { EmbeddingEntityType } from '@prisma/client';
import { prisma } from '@/lib/db';

export type RetrievedChunk = {
  embeddingId: string;
  entityType: EmbeddingEntityType;
  entityId: string;
  chunkIndex: number;
  text: string;
  /** Cosine distance: 0 = identical, 2 = opposite. Lower is more relevant. */
  distance: number;
};

export type RetrieveOptions = {
  /** Number of chunks to return (top-k). */
  k: number;
  /** Optional filter on entity types. Defaults to all. */
  entityTypes?: EmbeddingEntityType[];
};

/**
 * Cosine top-k retrieval against the `embeddings` table.
 *
 * Uses pgvector's `<=>` operator (cosine distance). The IVFFlat index
 * created in Phase A speeds this up for large corpora; for under ~10k
 * chunks the index is barely faster than a sequential scan but the
 * query plan is identical so we don't special-case it.
 *
 * Embedding parameter is passed as a `vector(1024)` literal via Prisma's
 * tagged-template `$queryRaw` so we don't have to worry about binding
 * the Float32Array — Voyage gives us a plain number array which we
 * stringify as `[v1,v2,…]`.
 */
export async function retrieveTopK(
  questionEmbedding: Float32Array,
  opts: RetrieveOptions,
): Promise<RetrievedChunk[]> {
  if (opts.k <= 0) return [];
  const vectorLiteral = `[${Array.from(questionEmbedding).join(',')}]`;

  // Conditional WHERE clause on entityType — Prisma's tagged template
  // doesn't compose well with `WHERE column = ANY($1::text[])` so we
  // branch on whether filtering is requested.
  if (opts.entityTypes && opts.entityTypes.length > 0) {
    return prisma.$queryRaw<RetrievedChunk[]>`
      SELECT
        id AS "embeddingId",
        "entityType",
        "entityId",
        "chunkIndex",
        text,
        embedding <=> ${vectorLiteral}::vector(1024) AS distance
      FROM embeddings
      WHERE "entityType"::text = ANY(${opts.entityTypes.map((t) => t.toString())}::text[])
      ORDER BY distance ASC
      LIMIT ${opts.k}
    `;
  }

  return prisma.$queryRaw<RetrievedChunk[]>`
    SELECT
      id AS "embeddingId",
      "entityType",
      "entityId",
      "chunkIndex",
      text,
      embedding <=> ${vectorLiteral}::vector(1024) AS distance
    FROM embeddings
    ORDER BY distance ASC
    LIMIT ${opts.k}
  `;
}
