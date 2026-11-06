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
  'updates.push.services.mozilla.com', // Firefox
  'web.push.apple.com', // Safari, iOS / iPadOS home-screen apps
]);
const PUSH_HOST_SUFFIXES = ['.push.apple.com', '.notify.windows.com'];

const PUSH_ENDPOINT_MAX = 2048;

export function isPushServiceEndpoint(endpoint: string): boolean {
  if (endpoint.length > PUSH_ENDPOINT_MAX) return false;
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '') {
    return false;
  }
  const host = u.hostname.toLowerCase();
  return PUSH_HOSTS.has(host) || PUSH_HOST_SUFFIXES.some((s) => host.endsWith(s));
}

// PushSubscription keys are base64url: p256dh is a 65-byte P-256 point (87
// chars), auth a 16-byte secret (22 chars). The caps leave padding headroom.
const base64url = /^[A-Za-z0-9_-]+={0,2}$/;

export const pushSubscriptionSchema = z.object({
  endpoint: z
    .string()
    .max(PUSH_ENDPOINT_MAX)
    .refine(isPushServiceEndpoint, 'Unsupported push service'),
  p256dh: z.string().min(1).max(128).regex(base64url),
  auth: z.string().min(1).max(64).regex(base64url),
  // Display-only (the settings device list), so truncate rather than reject.
  userAgent: z
    .string()
    .optional()
    .transform((s) => s?.slice(0, 512)),
});
