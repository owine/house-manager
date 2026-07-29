/**
 * Reminder due-state lives on `ReminderTarget`, so a reminder targeting six
 * things due on one day projects six identical calendar events — the events
 * carry no target name, so the repetition says nothing six times. It also
 * emitted six React siblings sharing one key, since `CalendarEvent.id` is the
 * reminder id.
 *
 * Generic over the event shape rather than importing `CalendarEvent`: that
 * avoids a type cycle with `queries.ts`, which imports this module.
 */
export function collapseDuplicateReminderEvents<T extends { kind: string; id: string; date: Date }>(
  events: readonly T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const ev of events) {
    // Space-joined, matching the convention in lib/digests/group.ts: `kind` is
    // a fixed lowercase word, ids are cuid ([0-9a-z]) and toISOString() is
    // fixed-format, so no part can contain the separator. `date` is a calendar
    // date at UTC midnight, so its ISO string is a stable per-day key.
    const key = `${ev.kind} ${ev.id} ${ev.date.toISOString()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ev);
  }
  return out;
}
