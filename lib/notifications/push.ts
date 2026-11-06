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
const PUSH_DEADLINE_MS = 30_000;

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
  // Rows stored before subscribe validated the endpoint. Skip them, but don't
  // report them gone: "gone" deletes the row, and if the allowlist ever misses
  // a real push service that would silently unsubscribe those devices for good.
  if (!isPushServiceEndpoint(sub.endpoint)) return { ok: false, reason: 'endpoint-not-allowed' };
  configureOnce();
  try {
    // web-push's `timeout` is a socket idle timeout: it stops a silent peer,
    // but one that trickles bytes resets it. The race bounds the whole send.
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('push send deadline exceeded')), PUSH_DEADLINE_MS);
    });
    try {
      await Promise.race([
        webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload),
          // web-push sets no socket timeout by default, so a peer that accepted
          // the connection and never answered held the notify worker, and every
          // user's reminders behind it.
          { timeout: PUSH_TIMEOUT_MS },
        ),
        deadline,
      ]);
    } finally {
      clearTimeout(timer);
    }
    return { ok: true };
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) {
      return { ok: false, reason: 'subscription-gone' };
    }
    return { ok: false, reason: (e as Error).message ?? 'unknown' };
  }
}
