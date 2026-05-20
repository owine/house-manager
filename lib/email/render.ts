import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * HTML-only by design. Plain text is NOT threaded through here — each
 * template builds its own `text` from resolved data (see templates/reminder.tsx).
 */
export function renderEmail(node: ReactElement): { html: string } {
  const body = renderToStaticMarkup(node);
  return { html: `<!doctype html>${body}` };
}
