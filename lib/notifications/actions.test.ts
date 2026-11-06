import { beforeEach, describe, expect, it, vi } from 'vitest';

const upsert = vi.fn(async () => ({ id: 'sub-1' }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { id: 'u1' } })) }));
vi.mock('@/lib/db', () => ({ prisma: { pushSubscription: { upsert } } }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { subscribePush } = await import('./actions');

const valid = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
  p256dh: `B${'A'.repeat(86)}`,
  auth: 'abcdefghijklmnopqrstuv',
};

beforeEach(() => upsert.mockClear());

describe('subscribePush', () => {
  it('stores a real browser subscription', async () => {
    expect(await subscribePush(valid)).toEqual({ ok: true, data: { id: 'sub-1' } });
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  // The endpoint is where the worker connects. Called directly (not through
  // PushManager), the action stored any string a member sent.
  it('refuses an endpoint that is not a push service, and stores nothing', async () => {
    const r = await subscribePush({ ...valid, endpoint: 'https://attacker.example:8443/hold' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.formError).toMatch(/push service/);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses a malformed payload', async () => {
    expect((await subscribePush({ endpoint: valid.endpoint })).ok).toBe(false);
    expect((await subscribePush('nope')).ok).toBe(false);
    expect(upsert).not.toHaveBeenCalled();
  });
});
