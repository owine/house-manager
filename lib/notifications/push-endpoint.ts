import { z } from 'zod';

/**
 * The push services browsers actually hand out endpoints on. A subscription's
 * endpoint is where the WORKER opens an outbound TLS connection, so accepting
 * any URL let a member point the worker at an arbitrary host:port/path, and a
 * peer that never answered held the shared notify worker indefinitely.
 *
 * Exact hosts, plus suffixes for services that shard across subdomains. A
 * browser outside this list fails loudly at subscribe time (the settings page
 * shows the error), not silently at send time.
 */
const PUSH_HOSTS = new Set([
  'fcm.googleapis.com', // Chrome, Edge, Opera, Samsung Internet, Android
  'android.googleapis.com', // older Chrome / GCM-era subscriptions
  'updates.push.services.mozilla.com', // Firefox
  'web.push.apple.com', // Safari, iOS / iPadOS home-screen apps
]);
// `.google.com`: Chrome also issues FCM endpoints on Google hosts such as
// jmt17.google.com. Every suffix here is an operator-owned zone, so matching a
// subdomain can only ever reach that operator's servers.
const PUSH_HOST_SUFFIXES = ['.google.com', '.push.apple.com', '.notify.windows.com'];

// Letters, digits and hyphens per label: the only hostnames on which the WHATWG
// URL parser (used here) and Node's legacy url.parse (which web-push uses to
// open the connection) are known to agree. See the canonical-form check below.
const LDH_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

const PUSH_ENDPOINT_MAX = 2048;

export function isPushServiceEndpoint(endpoint: string): boolean {
  if (endpoint.length > PUSH_ENDPOINT_MAX) return false;
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  // Only canonical input. The check runs on WHATWG's parse, but web-push
  // connects to whatever `url.parse` makes of the same string, and the two
  // disagree on non-canonical hosts: `https://db%2Epush.apple.com/` is
  // `db.push.apple.com` to WHATWG and `db` to url.parse. A browser's endpoint
  // is already canonical, so requiring `href === endpoint` costs nothing and
  // means the host checked is the host connected to.
  if (u.href !== endpoint) return false;
  if (u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '') {
    return false;
  }
  const host = u.hostname;
  if (!LDH_HOST.test(host)) return false;
  return PUSH_HOSTS.has(host) || PUSH_HOST_SUFFIXES.some((s) => host.endsWith(s));
}

// PushSubscription keys are base64url: p256dh is a 65-byte uncompressed P-256
// point, auth a 16-byte secret. Anything else makes web-push throw on every
// send (not "gone"), so the row would never be cleaned up.
const base64url = /^[A-Za-z0-9_-]+={0,2}$/;
const keyOfBytes = (bytes: number) =>
  z
    .string()
    .max(128)
    .regex(base64url)
    .refine((s) => Buffer.from(s, 'base64url').length === bytes, `must be ${bytes} bytes`);

export const pushSubscriptionSchema = z.object({
  endpoint: z
    .string()
    .max(PUSH_ENDPOINT_MAX)
    .refine(isPushServiceEndpoint, 'Unsupported push service'),
  p256dh: keyOfBytes(65),
  auth: keyOfBytes(16),
  // Display-only (the settings device list), so truncate rather than reject.
  userAgent: z
    .string()
    .optional()
    .transform((s) => s?.slice(0, 512)),
});
