import { diceSimilarity, NOTE_DEDUP_THRESHOLD } from './dice';

export type NoteTitle = { id: string; title: string };

/**
 * Find the existing note a draft title most likely restates.
 *
 * Synchronous and application-side rather than RAG: embeddings are written
 * asynchronously by the embed.content worker (and skipped entirely when
 * ASK_ENABLED is false), so a note created earlier in the SAME conversation is
 * not yet RAG-retrievable — which is the case this is here to catch.
 *
 * A house has hundreds of notes, not millions, so scanning them all in
 * application code is cheap and needs no pg_trgm extension.
 *
 * Returns the highest-scoring match above the threshold, or null.
 */
export function findDuplicateNote(
  draftTitle: string,
  existing: readonly NoteTitle[],
): NoteTitle | null {
  let best: NoteTitle | null = null;
  let bestScore = 0;

  for (const note of existing) {
    const score = diceSimilarity(draftTitle, note.title);
    if (score >= NOTE_DEDUP_THRESHOLD && score > bestScore) {
      best = note;
      bestScore = score;
    }
  }

  return best;
}
