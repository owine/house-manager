import Link from 'next/link';
import { SearchResults } from '@/components/search/SearchResults';
import { type SearchResult, searchAll } from '@/lib/search/queries';
import { SEARCH_KINDS, type SearchKind, searchQuerySchema } from '@/lib/search/schema';

type SearchParams = Promise<{
  q?: string;
  kind?: string;
  page?: string;
}>;

const PAGE_SIZE = 20;

const KIND_LABELS: Record<SearchKind, string> = {
  item: 'Items',
  vendor: 'Vendors',
  note: 'Notes',
  service: 'Services',
  reminder: 'Reminders',
  attachment: 'Attachments',
};

export default async function SearchPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const parsed = searchQuerySchema.safeParse({
    q: sp.q ?? '',
    kind: sp.kind,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  const empty: SearchResult = { hits: [], total: 0, facets: {} };
  const result = parsed.success ? await searchAll(parsed.data).catch(() => empty) : empty;

  const q = parsed.success ? parsed.data.q : (sp.q ?? '');
  const activeKind = parsed.success ? parsed.data.kind : undefined;

  return (
    <div>
      <h1>Search</h1>
      <form method="GET" action="/search" style={{ marginBottom: '1rem' }}>
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search across items, reminders, notes…"
          style={{ padding: '0.4rem', width: '100%', maxWidth: 480 }}
        />
      </form>

      {q && (
        <>
          <div
            style={{
              display: 'flex',
              gap: '0.4rem',
              flexWrap: 'wrap',
              marginBottom: '1rem',
            }}
          >
            <FacetPill href={`/search?q=${encodeURIComponent(q)}`} active={!activeKind}>
              All {result.total}
            </FacetPill>
            {SEARCH_KINDS.map((k) => {
              const count = result.facets.kind?.[k] ?? 0;
              if (count === 0 && k !== activeKind) return null;
              return (
                <FacetPill
                  key={k}
                  href={`/search?q=${encodeURIComponent(q)}&kind=${k}`}
                  active={activeKind === k}
                >
                  {KIND_LABELS[k]} {count}
                </FacetPill>
              );
            })}
          </div>

          <SearchResults hits={result.hits} variant="page" />

          {result.total > PAGE_SIZE && (
            <Pagination page={page} total={result.total} q={q} kind={activeKind} />
          )}
        </>
      )}
    </div>
  );
}

function FacetPill({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      style={{
        padding: '0.3rem 0.7rem',
        border: '1px solid var(--border)',
        borderRadius: '999px',
        background: active ? 'var(--bg-elevated)' : 'transparent',
        color: 'inherit',
        textDecoration: 'none',
        fontSize: '0.85rem',
      }}
    >
      {children}
    </Link>
  );
}

function Pagination({
  page,
  total,
  q,
  kind,
}: {
  page: number;
  total: number;
  q: string;
  kind?: SearchKind;
}) {
  const lastPage = Math.ceil(total / PAGE_SIZE);
  const buildHref = (p: number) =>
    `/search?q=${encodeURIComponent(q)}${kind ? `&kind=${kind}` : ''}&page=${p}`;
  return (
    <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
      {page > 1 && <Link href={buildHref(page - 1)}>← Prev</Link>}
      <span style={{ color: 'var(--fg-muted)' }}>
        Page {page} of {lastPage}
      </span>
      {page < lastPage && <Link href={buildHref(page + 1)}>Next →</Link>}
    </div>
  );
}
