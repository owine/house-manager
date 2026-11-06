import webpush from 'web-push';
import { getEnv } from '@/lib/env';
import { isPushServiceEndpoint } from './push-endpoint';

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

export const PUSH_TIMEOUT_MS = 10_000;

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
  // Rows stored before subscribe validated the endpoint. Reporting them gone
  // makes the notify job delete them instead of connecting to them.
  if (!isPushServiceEndpoint(sub.endpoint)) return { ok: false, reason: 'subscription-gone' };
  configureOnce();
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      // web-push sets no socket timeout by default, so a push service (or
      // anything else) that accepts the connection and never answers held
      // the notify worker, and every user's reminders behind it.
      { timeout: PUSH_TIMEOUT_MS },
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
