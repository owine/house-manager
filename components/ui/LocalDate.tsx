'use client';

import { useEffect, useState } from 'react';

type Props = {
  iso: string;
  mode?: 'date' | 'datetime';
};

/**
 * Renders an instant (timestamp) in the viewer's local timezone.
 * During SSR and initial render, displays the UTC-anchored fallback
 * to avoid layout shift. After hydration, swaps to local timezone.
 */
export function LocalDate({ iso, mode = 'date' }: Props) {
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    setIsHydrated(true);
  }, []);

  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  let displayText: string;
  if (isHydrated) {
    if (mode === 'datetime') {
      displayText = date.toLocaleString();
    } else {
      displayText = date.toLocaleDateString();
    }
  } else {
    // Fallback during SSR / before hydration
    if (mode === 'datetime') {
      displayText = iso;
    } else {
      displayText = iso.slice(0, 10);
    }
  }

  return (
    <time dateTime={iso} suppressHydrationWarning>
      {displayText}
    </time>
  );
}
