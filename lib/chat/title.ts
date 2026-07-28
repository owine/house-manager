// Derives a ChatSession title from the first user turn — no model call, so it
// is deterministic and free. Extracted from lib/chat/actions.ts so it is
// independently unit-testable (schema.ts is Zod-only per the feature-module
// convention, so this doesn't belong there).

/**
 * The first non-empty line of `firstTurn`, trimmed and truncated to 80 chars
 * on a word boundary. Falls back to `'Untitled'` when every line is blank,
 * and to a hard cut when the line has no usable space to break on (a single
 * long word/blob).
 */
export function deriveSessionTitle(firstTurn: string): string {
  const line =
    firstTurn
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? 'Untitled';
  if (line.length <= 80) return line;
  const cut = line.slice(0, 80);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
