'use server';
import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { getBoss, Queue } from '@/lib/queue';
import type { ActionResult } from '@/lib/result';

export async function reindexAll(): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, formError: 'Unauthorized' };
  const boss = await getBoss();
  await boss.send(Queue.SearchReindex, {});
  revalidatePath('/settings');
  return { ok: true, data: undefined };
}
