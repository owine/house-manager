import { auth } from '@/lib/auth';

export default async function Dashboard() {
  const session = await auth();
  return (
    <div>
      <h1>Hello, {session?.user?.name}</h1>
      <p>Foundation is ready. Core features arrive in subsequent plans.</p>
    </div>
  );
}
