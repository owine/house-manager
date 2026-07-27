// Character-bigram Dice similarity, used to detect near-duplicate note titles
// before proposing a new note (see the conversational-capture spec, §12).
//
// Character bigrams rather than word tokens: the titles this feature generates
// are short and frequently single-token ("Lightbulbs", "Filters"), where
// word-token Dice can only ever return 1.0 or 0.0. Bigrams also absorb plurals,
// spacing and typos.
//
// Known limitation: this is lexical, not semantic. It catches restatements
// ("Lightbulbs" / "Light bulbs" / "Lightbulbs (2)") but NOT synonym drift
// ("Lightbulbs" / "Bulb types" scores ~0.35). That is by design — no threshold
// catches the latter without also producing false positives.

/**
 * Match threshold. A guess pending real data: `prisma/seed.ts` creates no
 * notes, so there is no corpus in this repo to calibrate against. Expect to
 * tune once there is real usage.
 */
export const NOTE_DEDUP_THRESHOLD = 0.5;

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** Dice coefficient over character bigrams. Returns 0..1. */
export function diceSimilarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;

  // Too short to form a bigram — fall back to equality so single-character
  // titles don't silently score 0 against themselves.
  if (na.length < 2 || nb.length < 2) return na === nb ? 1 : 0;

  const ga = bigrams(na);
  const gb = bigrams(nb);

  let intersection = 0;
  for (const [g, countA] of ga) {
    const countB = gb.get(g);
    if (countB) intersection += Math.min(countA, countB);
  }

  const total = na.length - 1 + (nb.length - 1);
  return (2 * intersection) / total;
}
