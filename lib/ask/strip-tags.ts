/**
 * Strip inline citation tags the Ask LLM sometimes leaks into the answer
 * prose (e.g. `[SERVICE_RECORD cmp0…]`, `(entityId=…)`). Citations belong
 * in the structured `citations` array — they're for chip rendering, not
 * the human reader.
 *
 * Pure function so it's testable without dragging in the `'use server'`
 * imports from `actions.ts`. Idempotent on already-clean answers.
 */
export function stripInlineCitationTags(text: string): string {
  return (
    text
      // [ENTITY_TYPE cuid] or [ENTITY_TYPE entityId=cuid]
      .replaceAll(
        /\s*\[(?:ITEM|NOTE|SERVICE_RECORD|CHECKLIST_ITEM|WARRANTY|ATTACHMENT)(?:\s+(?:entityId=)?[a-z0-9]+)?\]/gi,
        '',
      )
      // (entityId=cuid) or (entityType=X entityId=Y) — parenthetical leak
      .replaceAll(/\s*\((?:entityType=[A-Z_]+\s*)?entityId=[a-z0-9]+\)/gi, '')
      // Collapse trailing whitespace before punctuation / newlines that the
      // strip leaves behind.
      .replaceAll(/[ \t]+([.,;:!?\n])/g, '$1')
      .trim()
  );
}
