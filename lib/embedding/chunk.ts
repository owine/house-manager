// Paragraph-based chunker with token overlap. Used by the embed-content
// worker to split long entity text (mostly attachment OCR output, but
// also note bodies + verbose service-record notes) into Voyage-sized
// pieces. Pure function — no I/O, no globals.
//
// Token counting is char-based (~4 chars / token). This is rough but
// adequate for chunking decisions; exact counts come from Voyage's
// response and are stored on `Embedding.tokenCount` for telemetry.

export const TOKEN_CHARS = 4;
export const TARGET_TOKENS_PER_CHUNK = 500;
const OVERLAP_TOKENS = 50;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / TOKEN_CHARS);
}

/**
 * Split text into chunks of approximately {@link TARGET_TOKENS_PER_CHUNK}
 * tokens, with {@link OVERLAP_TOKENS} of tail overlap between adjacent
 * chunks. Splits on paragraph boundaries (`\n\n`) first; falls back to
 * single-newline boundaries; then to sentence boundaries (`. `); only
 * mid-sentence as a last resort.
 *
 * Returns an empty array for empty / whitespace-only input.
 */
export function chunkText(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // Fast path: short enough to fit in one chunk.
  if (estimateTokens(trimmed) <= TARGET_TOKENS_PER_CHUNK) {
    return [trimmed];
  }

  // Build leaf units (paragraphs preferred). For each split level, try
  // until we have leaves that are individually below the target so we
  // can group them by accumulation. If a single leaf is still over the
  // target (e.g. a giant unbroken text block), fall back to a hard
  // character-window split for that leaf.
  const targetChars = TARGET_TOKENS_PER_CHUNK * TOKEN_CHARS;
  const overlapChars = OVERLAP_TOKENS * TOKEN_CHARS;

  const leaves: string[] = [];
  for (const para of trimmed.split(/\n\n+/)) {
    if (para.length <= targetChars) {
      if (para.trim()) leaves.push(para.trim());
      continue;
    }
    // Paragraph itself too long: split on single newlines, then sentences,
    // then by hard character window.
    for (const line of para.split(/\n+/)) {
      if (line.length <= targetChars) {
        if (line.trim()) leaves.push(line.trim());
        continue;
      }
      for (const sent of line.split(/(?<=[.!?])\s+/)) {
        if (sent.length <= targetChars) {
          if (sent.trim()) leaves.push(sent.trim());
          continue;
        }
        for (let i = 0; i < sent.length; i += targetChars) {
          leaves.push(sent.slice(i, i + targetChars));
        }
      }
    }
  }

  // Group leaves into chunks, sliding overlap from the previous chunk's tail.
  const chunks: string[] = [];
  let buf = '';
  for (const leaf of leaves) {
    if (buf.length === 0) {
      buf = leaf;
      continue;
    }
    if (buf.length + 2 + leaf.length <= targetChars) {
      buf = `${buf}\n\n${leaf}`;
      continue;
    }
    chunks.push(buf);
    // Seed next chunk with the tail of the previous one for overlap.
    const tail = buf.slice(-overlapChars);
    buf = `${tail}\n\n${leaf}`;
  }
  if (buf.length > 0) chunks.push(buf);
  return chunks;
}
