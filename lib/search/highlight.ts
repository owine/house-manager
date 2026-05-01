// Sentinels passed to Meilisearch via highlightPreTag/highlightPostTag in
// every search call. Chosen to be unlikely to appear in user content.
export const HL_OPEN = '__HL_OPEN__';
export const HL_CLOSE = '__HL_CLOSE__';

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPE_MAP[c] ?? c);
}

/**
 * Render a Meilisearch `_formatted` field value as HTML safe for React's
 * raw-HTML prop. All user content is HTML-escaped first; only the sentinel
 * pairs survive the pipeline as controlled <em> tags.
 */
export function safeHighlight(formatted: string): string {
  const escaped = escapeHtml(formatted);
  return escaped.split(HL_OPEN).join('<em>').split(HL_CLOSE).join('</em>');
}
