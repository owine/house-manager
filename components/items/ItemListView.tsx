'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';

type View = 'table' | 'cards';

const STORAGE_KEY = 'items.view';

function isValidView(v: string | null | undefined): v is View {
  return v === 'table' || v === 'cards';
}

type Props = {
  initialView: View | null;
  table: ReactNode;
  cards: ReactNode;
};

export function ItemListView({ initialView, table, cards }: Props) {
  // SSR pass: use initialView ?? 'table' to avoid hydration mismatch.
  // After mount, resolve localStorage and viewport in useEffect.
  const [view, setView] = useState<View>(initialView ?? 'table');
  const [mounted, setMounted] = useState(false);

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (initialView) {
      // URL wins — also persist to localStorage
      localStorage.setItem(STORAGE_KEY, initialView);
      setView(initialView);
    } else {
      // Try localStorage, then viewport
      const stored = localStorage.getItem(STORAGE_KEY);
      if (isValidView(stored)) {
        setView(stored);
      } else {
        const isMobile = window.matchMedia('(max-width: 768px)').matches;
        setView(isMobile ? 'cards' : 'table');
      }
    }
    setMounted(true);
  }, [initialView]);

  function handleToggle(next: View) {
    localStorage.setItem(STORAGE_KEY, next);
    setView(next);
    const sp = new URLSearchParams(searchParams.toString());
    sp.set('view', next);
    router.replace(`${pathname}?${sp.toString()}`);
  }

  return (
    <div>
      <div
        style={{
          display: 'flex',
          gap: '0.5rem',
          marginBottom: '1rem',
          justifyContent: 'flex-end',
        }}
      >
        <button
          type="button"
          onClick={() => handleToggle('table')}
          aria-pressed={mounted ? view === 'table' : undefined}
          style={{
            padding: '0.25rem 0.75rem',
            borderRadius: '4px',
            border: '1px solid var(--border-strong)',
            cursor: 'pointer',
            fontWeight: view === 'table' ? 700 : 400,
            background: view === 'table' ? 'var(--fg)' : 'var(--bg)',
            color: view === 'table' ? 'var(--bg)' : 'var(--fg)',
          }}
        >
          Table
        </button>
        <button
          type="button"
          onClick={() => handleToggle('cards')}
          aria-pressed={mounted ? view === 'cards' : undefined}
          style={{
            padding: '0.25rem 0.75rem',
            borderRadius: '4px',
            border: '1px solid var(--border-strong)',
            cursor: 'pointer',
            fontWeight: view === 'cards' ? 700 : 400,
            background: view === 'cards' ? 'var(--fg)' : 'var(--bg)',
            color: view === 'cards' ? 'var(--bg)' : 'var(--fg)',
          }}
        >
          Cards
        </button>
      </div>
      {view === 'table' ? table : cards}
    </div>
  );
}
