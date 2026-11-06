/**
 * How much of a session's thread a chat turn replays to the model.
 *
 * The hourly chat budget counts turns, not tokens, and a session's history
 * grows without limit, so without this one budget unit could replay a whole
 * long session into both model calls (main + parts), up to the context
 * window each time. ~48K chars is roughly 12K tokens of prior context: about
 * six maximal (8000-char) user turns, or many ordinary ones.
 */
export const HISTORY_CHAR_BUDGET = 48_000;

type Turn = { role: 'user' | 'assistant'; content: string };

/**
 * The newest messages that fit in `budget` chars, oldest first.
 *
 * Whole messages only (a cut message would misquote the member), and the
 * result starts on a user message: the Messages API requires the first message
 * to be the user's, and dropping a leading assistant reply orphaned from its
 * question loses nothing the model could use.
 */
export function boundHistory<T extends Turn>(
  msgs: readonly T[],
  budget = HISTORY_CHAR_BUDGET,
): T[] {
  let start = msgs.length;
  let used = 0;
  while (start > 0) {
    const m = msgs[start - 1] as T;
    if (used + m.content.length > budget) break;
    used += m.content.length;
    start--;
  }
  while (start < msgs.length && msgs[start]?.role !== 'user') start++;
  return msgs.slice(start);
}
