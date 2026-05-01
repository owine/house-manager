'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { SearchHit } from '@/lib/search/queries';
import { SearchResults } from './SearchResults';

const DEBOUNCE_MS = 250;
const DROPDOWN_LIMIT = 5;

export function SearchBar() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      setError(null);
      return;
    }
    const handle = setTimeout(async () => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const res = await fetch(
          `/api/search?q=${encodeURIComponent(query)}&limit=${DROPDOWN_LIMIT}`,
          { signal: ctrl.signal },
        );
        if (res.status === 503) {
          setError('Search temporarily unavailable');
          setHits([]);
          return;
        }
        if (!res.ok) return;
        const data = (await res.json()) as { hits: SearchHit[] };
        setHits(data.hits);
        setError(null);
      } catch (e) {
        if ((e as { name?: string }).name !== 'AbortError') {
          console.warn('search fetch failed', e);
        }
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (query.trim()) {
        router.push(`/search?q=${encodeURIComponent(query)}`);
        setOpen(false);
      }
    }
  }

  return (
    <div ref={containerRef} style={{ position: 'relative', flex: 1, maxWidth: 360 }}>
      <input
        ref={inputRef}
        type="search"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder="Search…"
        style={{ width: '100%', padding: '0.4rem 0.6rem' }}
      />
      {open && (query.trim() || error) && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderTop: 'none',
            zIndex: 100,
            maxHeight: 400,
            overflowY: 'auto',
          }}
        >
          {error ? (
            <p style={{ padding: '0.5rem', color: 'var(--fg-muted)' }}>{error}</p>
          ) : (
            <>
              <SearchResults hits={hits} variant="dropdown" onItemClick={() => setOpen(false)} />
              {hits.length > 0 && (
                <div
                  style={{
                    padding: '0.4rem 0.6rem',
                    borderTop: '1px solid var(--border)',
                    fontSize: '0.85rem',
                    textAlign: 'right',
                  }}
                >
                  <Link
                    href={`/search?q=${encodeURIComponent(query)}`}
                    onClick={() => setOpen(false)}
                  >
                    See all results →
                  </Link>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
