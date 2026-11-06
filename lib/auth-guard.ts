import { redirect } from 'next/navigation';
import { cache } from 'react';
import { auth } from '@/lib/auth';

// Per-segment auth gate for everything under `app/(app)/`.
//
// A layout is NOT an authorization boundary. Next renders a route's layout and
// page segments in parallel, so the page's data reads run — and the page's RSC
// payload is serialized into the response — whether or not the layout's
// `redirect()` fires. An unauthenticated request to `/items` received the
// item list in the flight data despite the layout redirecting it. Every page
// default export and every `generateMetadata` must therefore gate itself, by
// calling one of these first, before any query.
//
// `cache()` dedupes the session lookup across the layout, metadata and page of
// one request (each `auth()` call is a database-session read otherwise).
// `tests/unit/app-auth-gate.test.ts` fails when a page under `app/(app)/`
// forgets to call one.

export const requireUser = cache(async () => {
  const session = await auth();
  if (!session?.user?.id) redirect('/api/auth/signin');
  return session as typeof session & { user: { id: string } };
});

export const requireAdmin = cache(async () => {
  const session = await requireUser();
  if ((session.user as { role?: string | null }).role !== 'ADMIN') redirect('/');
  return session;
});
