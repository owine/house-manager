import { describe, expect, it } from 'vitest';
import { defaultNotificationPrefs, notificationPrefsSchema } from './prefs';

describe('notificationPrefsSchema', () => {
  it('parses a complete object', () => {
    const r = notificationPrefsSchema.safeParse({
      pushEnabled: true,
      emailEnabled: false,
      quietStart: '22:00',
      quietEnd: '07:00',
      timezone: 'America/Chicago',
    });
    expect(r.success).toBe(true);
  });

  it('applies defaults for missing fields', () => {
    const r = notificationPrefsSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual(defaultNotificationPrefs);
  });

  it('rejects malformed time strings', () => {
    const r = notificationPrefsSchema.safeParse({ quietStart: '25:00' });
    expect(r.success).toBe(false);
  });
});
