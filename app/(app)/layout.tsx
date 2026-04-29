import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';

// SOLE AUTH GATE for the application. middleware.ts was deleted in Task 12 to
// avoid an Auth.js v5 JWE-vs-database-session incompatibility, so authenticated
// pages must live under this route group `app/(app)/` to inherit the redirect
// below. New protected routes belong here — putting them at the top level (e.g.
// `app/items/`) ships them publicly. If we add more protected groups, switch
// the session strategy to JWT and re-introduce middleware.ts.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect('/api/auth/signin');
  return (
    <div>
      <header style={{ padding: '1rem', borderBottom: '1px solid var(--border)' }}>
        <strong>House Manager</strong>
        <span style={{ marginLeft: '1rem' }}>Signed in as {session.user.name}</span>
      </header>
      <main style={{ padding: '1rem' }}>{children}</main>
    </div>
  );
}
