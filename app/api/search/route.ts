import { auth } from '@/lib/auth';
import { searchAll } from '@/lib/search/queries';
import { searchQuerySchema } from '@/lib/search/schema';

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user) return new Response('Unauthorized', { status: 401 });

  const url = new URL(req.url);
  const params: Record<string, string> = {};
  for (const [k, v] of url.searchParams) params[k] = v;

  const parsed = searchQuerySchema.safeParse(params);
  if (!parsed.success) {
    return Response.json(
      { error: 'invalid-query', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const result = await searchAll(parsed.data);
    return Response.json(result, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    console.warn('search query failed', {
      q: parsed.data.q,
      error: (e as Error).message,
    });
    return Response.json({ error: 'search-unavailable' }, { status: 503 });
  }
}
