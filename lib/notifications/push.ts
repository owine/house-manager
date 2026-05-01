import webpush from 'web-push';
import { getEnv } from '@/lib/env';

let configured = false;

function configureOnce() {
  if (configured) return;
  const env = getEnv();
  webpush.setVapidDetails(
    env.WEB_PUSH_CONTACT_EMAIL,
    env.WEB_PUSH_VAPID_PUBLIC_KEY,
    env.WEB_PUSH_VAPID_PRIVATE_KEY,
  );
  configured = true;
}

export type PushPayload = {
  title: string;
  body: string;
  url: string;
};

export type PushSubscriptionRecord = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

export type SendPushResult = { ok: true } | { ok: false; reason: 'subscription-gone' | string };

export async function sendPush(
  sub: PushSubscriptionRecord,
  payload: PushPayload,
): Promise<SendPushResult> {
  configureOnce();
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
    );
    return { ok: true };
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) {
      return { ok: false, reason: 'subscription-gone' };
    }
    return { ok: false, reason: (e as Error).message ?? 'unknown' };
  }
}
