import { parse as legacyParse } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isPushServiceEndpoint, pushSubscriptionSchema } from './push-endpoint';

const P256DH = `B${'A'.repeat(86)}`;
const AUTH = 'abcdefghijklmnopqrstuv';

const ACCEPTED = [
  'https://fcm.googleapis.com/fcm/send/dXk3Yz:APA91bH',
  'https://android.googleapis.com/gcm/send/dXk3Yz:APA91bH',
  'https://jmt17.google.com/fcm/send/dXk3Yz:APA91bH',
  'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABk',
  'https://web.push.apple.com/QGv8n1aZ',
  'https://api.push.apple.com/3/device/abc',
  'https://wns2-par02p.notify.windows.com/w/?token=BQYAAA',
];

describe('isPushServiceEndpoint', () => {
  it.each(ACCEPTED)('accepts a browser push service: %s', (url) => {
    expect(isPushServiceEndpoint(url)).toBe(true);
  });

  // web-push opens the connection with Node's legacy url.parse, not WHATWG
  // URL. Every endpoint the check accepts must name the same host to both.
  it.each(ACCEPTED)('url.parse agrees on the host of %s', (url) => {
    expect(legacyParse(url).hostname).toBe(new URL(url).hostname);
  });

  it.each([
    ['plain http', 'http://fcm.googleapis.com/fcm/send/x'],
    ['an explicit port', 'https://fcm.googleapis.com:8443/fcm/send/x'],
    ['credentials', 'https://u:p@fcm.googleapis.com/fcm/send/x'],
    ['an arbitrary host', 'https://attacker.example/hook'],
    ['an internal host', 'https://db:5432/'],
    ['an IP literal', 'https://169.254.169.254/latest/meta-data'],
    ['a lookalike suffix', 'https://fcm.googleapis.com.attacker.example/x'],
    ['a suffix without its dot', 'https://evilpush.apple.com/x'],
    ['not a URL', 'e1'],
    ['an over-long URL', `https://fcm.googleapis.com/${'a'.repeat(2100)}`],
    // Parser differentials: WHATWG decodes these to an allowlisted host,
    // url.parse (what web-push connects with) reads the host as `db` / `ex`.
    ['a percent-encoded dot in the host', 'https://db%2Epush.apple.com/x'],
    ['a percent-encoded underscore in the host', 'https://ex%5Fample.push.apple.com/'],
    ['an underscore in the host', 'https://ex_ample.push.apple.com/'],
    ['a non-canonical (uppercase) host', 'https://FCM.googleapis.com/fcm/send/x'],
    ['a backslash', 'https://fcm.googleapis.com\\@db/x'],
    ['a trailing-dot host', 'https://fcm.googleapis.com./fcm/send/x'],
  ])('rejects %s', (_label, url) => {
    expect(isPushServiceEndpoint(url)).toBe(false);
  });
});

describe('pushSubscriptionSchema', () => {
  const ok = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    p256dh: P256DH,
    auth: AUTH,
    userAgent: 'Mozilla/5.0',
  };

  it('accepts what PushManager.subscribe() produces', () => {
    expect(pushSubscriptionSchema.safeParse(ok).success).toBe(true);
  });

  it('rejects keys that are not base64url, or not the real key sizes', () => {
    expect(pushSubscriptionSchema.safeParse({ ...ok, p256dh: 'not base64!' }).success).toBe(false);
    expect(pushSubscriptionSchema.safeParse({ ...ok, auth: 'a'.repeat(65) }).success).toBe(false);
    // web-push throws on every send with a bad key, so a 1-char key is a row
    // that never sends and never gets cleaned up.
    expect(pushSubscriptionSchema.safeParse({ ...ok, p256dh: 'A' }).success).toBe(false);
    expect(pushSubscriptionSchema.safeParse({ ...ok, auth: 'A' }).success).toBe(false);
  });

  it('truncates a long user agent rather than rejecting the device', () => {
    const r = pushSubscriptionSchema.safeParse({ ...ok, userAgent: 'x'.repeat(2000) });
    expect(r.success && r.data.userAgent?.length).toBe(512);
  });
});
