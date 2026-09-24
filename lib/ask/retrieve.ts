import { type EmbeddingEntityType, Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { LIVE_SOURCE_SQL } from '@/lib/embedding/live-source';

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
 * Nearest candidates handed from the ANN scan to the liveness filter, per
 * requested chunk. Dead sources are rare once embed.backfill sweeps them, so
 * 2× rarely comes up short. When it does, the result is just shorter than k,
 * never wrong.
 */
const CANDIDATE_MULTIPLIER = 2;

/**
 * Cosine top-k retrieval against the `embeddings` table, restricted to chunks
 * whose source is live (lib/embedding/live-source.ts).
 *
 * Two layers on purpose. The inner query is the same nearest-neighbour scan as
 * before (pgvector `<=>`, with the optional entityType filter), so the
 * planner's choice for it does not move (the IVFFlat question, P-H1, is
 * deliberately out of scope). The outer query drops chunks whose source row is
 * gone, archived or opted out. It runs one indexed EXISTS per candidate rather
 * than per row in the table. That makes a deleted invoice unreachable from the
 * chat prompt the moment its row goes, not only after the next sweep (Q-H2).
 *
 * The question embedding is passed as a `vector(1024)` literal. Voyage gives a
 * plain number array, which is stringified as `[v1,v2,…]`.
 */
export async function retrieveTopK(
  questionEmbedding: Float32Array,
  opts: RetrieveOptions,
): Promise<RetrievedChunk[]> {
  if (opts.k <= 0) return [];
  const vectorLiteral = `[${Array.from(questionEmbedding).join(',')}]`;
  const typeFilter =
    opts.entityTypes && opts.entityTypes.length > 0
      ? Prisma.sql`WHERE "entityType"::text = ANY(${opts.entityTypes.map((t) => t.toString())}::text[])`
      : Prisma.empty;

  return prisma.$queryRaw<RetrievedChunk[]>`
    SELECT e."embeddingId", e."entityType", e."entityId", e."chunkIndex", e.text, e.distance
    FROM (
      SELECT
        id AS "embeddingId",
        "entityType",
        "entityId",
        "chunkIndex",
        text,
        embedding <=> ${vectorLiteral}::vector(1024) AS distance
      FROM embeddings
      ${typeFilter}
      ORDER BY distance ASC
      LIMIT ${opts.k * CANDIDATE_MULTIPLIER}
    ) e
    WHERE ${LIVE_SOURCE_SQL}
    ORDER BY e.distance ASC
    LIMIT ${opts.k}
  `;
}
