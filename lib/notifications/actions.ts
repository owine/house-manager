'use server';
import { randomBytes } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import type { ActionResult } from '@/lib/result';
import { notificationPrefsSchema } from './prefs';

export async function saveNotificationPrefs(input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, formError: 'Unauthorized' };
  const parsed = notificationPrefsSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  await prisma.user.update({
    where: { id: session.user.id },
    data: { notificationPrefs: parsed.data },
  });
  revalidatePath('/settings');
  return { ok: true, data: undefined };
}

export type PushSubscriptionInput = {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
};

export async function subscribePush(
  input: PushSubscriptionInput,
): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, formError: 'Unauthorized' };
  if (!input.endpoint || !input.p256dh || !input.auth) {
    return { ok: false, formError: 'Invalid subscription payload' };
  }
  // Upsert by endpoint (devices can re-subscribe).
  const sub = await prisma.pushSubscription.upsert({
    where: { endpoint: input.endpoint },
    create: {
      userId: session.user.id,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      userAgent: input.userAgent ?? null,
    },
    update: {
      userId: session.user.id,
      p256dh: input.p256dh,
      auth: input.auth,
      userAgent: input.userAgent ?? null,
    },
    select: { id: true },
  });
  revalidatePath('/settings');
  return { ok: true, data: { id: sub.id } };
}

export async function unsubscribePush(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, formError: 'Unauthorized' };
  await prisma.pushSubscription.delete({ where: { id } });
  revalidatePath('/settings');
  return { ok: true, data: undefined };
}

export async function regenerateIcsToken(): Promise<ActionResult<{ token: string }>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, formError: 'Unauthorized' };
  const token = randomBytes(24).toString('base64url');
  await prisma.user.update({
    where: { id: session.user.id },
    data: { icsToken: token },
  });
  revalidatePath('/settings');
  return { ok: true, data: { token } };
}
