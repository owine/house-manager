const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

const RESERVED_KEYS = new Set(['page', 'pageSize', 'sort', 'q', 'view', 'tab']);

export type ListParams = {
  page: number;
  pageSize: number;
  sort?: string;
  q?: string;
  filters: Record<string, string[]>;
};

export function parseListParams(sp: URLSearchParams): ListParams {
  const rawPage = Number.parseInt(sp.get('page') ?? '1', 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;

  const rawPageSize = Number.parseInt(sp.get('pageSize') ?? String(DEFAULT_PAGE_SIZE), 10);
  const pageSize =
    Number.isFinite(rawPageSize) && rawPageSize >= 1
      ? Math.min(rawPageSize, MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;

  const sort = sp.get('sort') ?? undefined;
  const q = sp.get('q') ?? undefined;

  const filters: Record<string, string[]> = {};
  for (const [key, value] of sp.entries()) {
    if (RESERVED_KEYS.has(key)) continue;
    filters[key] = value.split(',').filter(Boolean);
  }

  return { page, pageSize, sort, q, filters };
}

export function serializeListParams(params: Partial<ListParams>): string {
  const sp = new URLSearchParams();
  if (params.page && params.page !== 1) sp.set('page', String(params.page));
  if (params.pageSize && params.pageSize !== DEFAULT_PAGE_SIZE)
    sp.set('pageSize', String(params.pageSize));
  if (params.sort) sp.set('sort', params.sort);
  if (params.q) sp.set('q', params.q);
  if (params.filters) {
    for (const [key, values] of Object.entries(params.filters)) {
      if (values.length > 0) sp.set(key, values.join(','));
    }
  }
  return sp.toString();
}
