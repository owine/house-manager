import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the web-push package. push.ts does `import webpush from 'web-push'`
// (default import), so the mock must expose a `default` object carrying the
// two methods we drive. Mirrors lib/embedding/voyage.test.ts's module-mock
// style.
vi.mock('web-push', () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() },
}));

// Mock env so configureOnce() has stable VAPID details without validating the
// full env. Mirrors lib/notifications/email.test.ts.
vi.mock('@/lib/env', () => ({
  getEnv: () => ({
    WEB_PUSH_CONTACT_EMAIL: 'mailto:house@example.com',
    WEB_PUSH_VAPID_PUBLIC_KEY: 'pub-key',
    WEB_PUSH_VAPID_PRIVATE_KEY: 'priv-key',
  }),
}));

// push.ts holds a module-level `configured` flag that persists across calls.
// To assert "setVapidDetails called exactly once across two sendPush calls"
// deterministically, each test re-imports a fresh module copy via
// vi.resetModules() + dynamic import in beforeEach, so the flag (and the
// web-push mock's call counts) start clean every test.
let webpush: {
  setVapidDetails: ReturnType<typeof vi.fn>;
  sendNotification: ReturnType<typeof vi.fn>;
};
let sendPush: typeof import('./push').sendPush;

const SUB = {
  id: 'sub-1',
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
  p256dh: 'p256',
  auth: 'authtok',
};
const PAYLOAD = { title: 'Due soon', body: 'Replace filter', url: '/reminders' };

beforeEach(async () => {
  vi.resetModules();
  webpush = ((await import('web-push')) as unknown as { default: typeof webpush }).default;
  ({ sendPush } = await import('./push'));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('sendPush', () => {
  it('sends the subscription + JSON payload and returns ok on success', async () => {
    webpush.sendNotification.mockResolvedValueOnce(undefined);

    const result = await sendPush(SUB, PAYLOAD);

    expect(result).toEqual({ ok: true });
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    expect(webpush.sendNotification).toHaveBeenCalledWith(
      { endpoint: SUB.endpoint, keys: { p256dh: SUB.p256dh, auth: SUB.auth } },
      JSON.stringify(PAYLOAD),
      { timeout: 10_000 },
    );
  });

  // Without a timeout, a peer that accepted the connection and never answered
  // held the notify worker, and every user's reminders behind it.
  it('bounds every send with a socket timeout', async () => {
    webpush.sendNotification.mockResolvedValueOnce(undefined);
    await sendPush(SUB, PAYLOAD);
    const opts = webpush.sendNotification.mock.calls[0]?.[2] as { timeout?: number } | undefined;
    expect(opts?.timeout).toBeGreaterThan(0);
  });

  // Rows stored before subscribe validated the endpoint. Skipped, but not
  // "gone": gone deletes the row, which an allowlist gap would make permanent.
  it('never connects to a stored endpoint outside the push services', async () => {
    const result = await sendPush({ ...SUB, endpoint: 'https://attacker.example/hold' }, PAYLOAD);
    expect(result).toEqual({ ok: false, reason: 'endpoint-not-allowed' });
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  // The socket timeout is an idle timeout; a peer trickling bytes resets it.
  it('gives up on a send that never settles, at the overall deadline', async () => {
    vi.useFakeTimers();
    try {
      webpush.sendNotification.mockReturnValueOnce(new Promise(() => {}));
      const pending = sendPush(SUB, PAYLOAD);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await pending).toEqual({ ok: false, reason: 'push send deadline exceeded' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps a 410 Gone to subscription-gone', async () => {
    webpush.sendNotification.mockRejectedValueOnce(
      Object.assign(new Error('gone'), { statusCode: 410 }),
    );

    const result = await sendPush(SUB, PAYLOAD);

    expect(result).toEqual({ ok: false, reason: 'subscription-gone' });
  });

  it('maps a 404 Not Found to subscription-gone', async () => {
    webpush.sendNotification.mockRejectedValueOnce(
      Object.assign(new Error('nope'), { statusCode: 404 }),
    );

    const result = await sendPush(SUB, PAYLOAD);

    expect(result).toEqual({ ok: false, reason: 'subscription-gone' });
  });

  it('carries the error message for a non-gone statusCode (500)', async () => {
    webpush.sendNotification.mockRejectedValueOnce(
      Object.assign(new Error('server exploded'), { statusCode: 500 }),
    );

    const result = await sendPush(SUB, PAYLOAD);

    expect(result).toEqual({ ok: false, reason: 'server exploded' });
  });

  it('carries the error message for a plain Error with no statusCode', async () => {
    webpush.sendNotification.mockRejectedValueOnce(new Error('boom'));

    const result = await sendPush(SUB, PAYLOAD);

    expect(result).toEqual({ ok: false, reason: 'boom' });
  });

  it('configures VAPID details exactly once across two sendPush calls', async () => {
    webpush.sendNotification.mockResolvedValue(undefined);

    await sendPush(SUB, PAYLOAD);
    await sendPush(SUB, PAYLOAD);

    expect(webpush.setVapidDetails).toHaveBeenCalledTimes(1);
    expect(webpush.setVapidDetails).toHaveBeenCalledWith(
      'mailto:house@example.com',
      'pub-key',
      'priv-key',
    );
    expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
  });
});
