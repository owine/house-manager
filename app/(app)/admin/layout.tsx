import { requireAdmin } from '@/lib/auth-guard';

// UX only — each admin page calls requireAdmin() itself (see lib/auth-guard.ts).
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();
  return <>{children}</>;
}
