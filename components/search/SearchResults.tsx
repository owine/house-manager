import Link from 'next/link';
import { HL_CLOSE, HL_OPEN } from '@/lib/search/highlight';
import type { SearchHit } from '@/lib/search/queries';

type Props = {
  hits: SearchHit[];
  variant?: 'dropdown' | 'page';
  onItemClick?: () => void;
};

// Splits a Meilisearch _formatted string on HL_OPEN/HL_CLOSE sentinels and
// returns alternating plain text + <em>-wrapped highlight nodes. Text segments
// are rendered through React, so the framework HTML-escapes them; sentinels
// never reach the DOM as raw HTML.
function renderHighlighted(formatted: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const parts = formatted.split(HL_OPEN);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i === 0) {
      nodes.push(part);
      continue;
    }
    const closeIdx = part.indexOf(HL_CLOSE);
    if (closeIdx === -1) {
      nodes.push(part);
      continue;
    }
    nodes.push(<em key={i}>{part.slice(0, closeIdx)}</em>);
    nodes.push(part.slice(closeIdx + HL_CLOSE.length));
  }
  return nodes;
}

export function SearchResults({ hits, variant = 'page', onItemClick }: Props) {
  if (hits.length === 0) {
    return <p style={{ color: 'var(--fg-muted)', padding: '0.5rem' }}>No results.</p>;
  }
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {hits.map((hit) => (
        <li
          key={hit.id}
          style={{
            borderBottom: '1px solid var(--border)',
            padding: variant === 'dropdown' ? '0.4rem 0.6rem' : '0.6rem 0',
          }}
        >
          <Link
            href={hit.href}
            onClick={onItemClick}
            style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.4rem' }}>
              <span aria-hidden style={{ flexShrink: 0 }}>
                {hit.iconHint}
              </span>
              <span style={{ fontWeight: 500 }}>
                {renderHighlighted(hit._formatted?.title ?? hit.title)}
              </span>
            </div>
            {variant === 'page' && hit._formatted?.body && (
              <p
                style={{
                  color: 'var(--fg-muted)',
                  fontSize: '0.85rem',
                  margin: '0.2rem 0 0 1.5rem',
                }}
              >
                {renderHighlighted(hit._formatted.body.slice(0, 200))}
              </p>
            )}
          </Link>
        </li>
      ))}
    </ul>
  );
}
