import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/auth-guard';

export default async function AdminIndexPage() {
  await requireAdmin();
  redirect('/admin/ai');
}
