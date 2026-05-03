import Link from 'next/link';
import { ListPageShell } from '@/app/(app)/_components/ListPageShell';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { SearchResults } from '@/components/search/SearchResults';
import { badgeVariants } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { type SearchResult, searchAll } from '@/lib/search/queries';
import { SEARCH_KINDS, type SearchKind, searchQuerySchema } from '@/lib/search/schema';
import { cn } from '@/lib/utils';

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
    <ListPageShell header={<PageHeader title="Search" />}>
      <form method="GET" action="/search" className="mb-4">
        <Input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search across items, reminders, notes…"
          className="max-w-xl"
        />
      </form>

      {q && (
        <>
          <div className="mb-4 flex flex-wrap gap-2">
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
    </ListPageShell>
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
      className={cn(
        badgeVariants({ variant: active ? 'default' : 'outline' }),
        'cursor-pointer hover:opacity-80',
      )}
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
    <div className="mt-4 flex items-center gap-3">
      {page > 1 && (
        <Button variant="outline" size="sm" render={<Link href={buildHref(page - 1)} />}>
          ← Prev
        </Button>
      )}
      <span className="text-sm text-muted-foreground">
        Page {page} of {lastPage}
      </span>
      {page < lastPage && (
        <Button variant="outline" size="sm" render={<Link href={buildHref(page + 1)} />}>
          Next →
        </Button>
      )}
    </div>
  );
}
