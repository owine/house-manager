'use client';
import { useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

/**
 * When the page URL has `?attachment=<id>`, find the matching
 * `[data-attachment-id]` card, scroll it into view, and pulse a highlight
 * ring for 2 seconds. Used by /ask citation chips to deep-link from a
 * cited attachment into its parent entity's page.
 *
 * Pure side-effect component; renders nothing. Safe to mount anywhere
 * on a page that lists attachments.
 */
export function AttachmentScrollHighlight() {
  const searchParams = useSearchParams();
  const targetId = searchParams.get('attachment');

  useEffect(() => {
    if (!targetId) return;
    const el = document.querySelector<HTMLElement>(
      `[data-attachment-id="${CSS.escape(targetId)}"]`,
    );
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Pulse: add a ring class for 2s, then strip. Tailwind v4 utilities.
    el.classList.add('ring-2', 'ring-primary');
    const timer = window.setTimeout(() => {
      el.classList.remove('ring-2', 'ring-primary');
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [targetId]);

  return null;
}
