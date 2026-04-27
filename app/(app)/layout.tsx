import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect('/api/auth/signin');
  return (
    <div>
      <header style={{ padding: '1rem', borderBottom: '1px solid #ddd' }}>
        <strong>House Manager</strong>
        <span style={{ marginLeft: '1rem' }}>Signed in as {session.user.name}</span>
      </header>
      <main style={{ padding: '1rem' }}>{children}</main>
    </div>
  );
}
