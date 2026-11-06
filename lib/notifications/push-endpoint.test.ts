import { describe, expect, it } from 'vitest';
import { isPushServiceEndpoint, pushSubscriptionSchema } from './push-endpoint';

const P256DH = `B${'A'.repeat(86)}`;
const AUTH = 'abcdefghijklmnopqrstuv';

describe('isPushServiceEndpoint', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/dXk3Yz:APA91bH',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABk',
    'https://web.push.apple.com/QGv8n1aZ',
    'https://api.push.apple.com/3/device/abc',
    'https://wns2-par02p.notify.windows.com/w/?token=BQYAAA',
  ])('accepts a browser push service: %s', (url) => {
    expect(isPushServiceEndpoint(url)).toBe(true);
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

  it('rejects keys that are not base64url, or oversized', () => {
    expect(pushSubscriptionSchema.safeParse({ ...ok, p256dh: 'not base64!' }).success).toBe(false);
    expect(pushSubscriptionSchema.safeParse({ ...ok, auth: 'a'.repeat(65) }).success).toBe(false);
  });

  it('truncates a long user agent rather than rejecting the device', () => {
    const r = pushSubscriptionSchema.safeParse({ ...ok, userAgent: 'x'.repeat(2000) });
    expect(r.success && r.data.userAgent?.length).toBe(512);
  });
});
