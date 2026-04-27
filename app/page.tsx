import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';

export default async function Home() {
  const session = await auth();
  if (session?.user) redirect('/dashboard');
  return (
    <main style={{ padding: '2rem' }}>
      <h1>House Manager</h1>
      <a href="/api/auth/signin">Sign in</a>
    </main>
  );
}
