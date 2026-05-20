import { describe, expect, it } from 'vitest';
import { defaultNotificationPrefs, notificationPrefsSchema, readNotificationPrefs } from './prefs';

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

  it('returns new digest defaults when reading null', () => {
    const prefs = readNotificationPrefs(null);
    expect(prefs.overdueDigestEnabled).toBe(false);
    expect(prefs.overdueDigestHour).toBe(8);
    expect(prefs.weeklySummaryEnabled).toBe(false);
    expect(prefs.weeklySummaryDay).toBe(1);
    expect(prefs.weeklySummaryHour).toBe(8);
  });

  it('rejects overdueDigestHour outside 0-23 range', () => {
    const r24 = notificationPrefsSchema.safeParse({ overdueDigestHour: 24 });
    expect(r24.success).toBe(false);

    const rNeg = notificationPrefsSchema.safeParse({ overdueDigestHour: -1 });
    expect(rNeg.success).toBe(false);

    const r0 = notificationPrefsSchema.safeParse({ overdueDigestHour: 0 });
    expect(r0.success).toBe(true);

    const r23 = notificationPrefsSchema.safeParse({ overdueDigestHour: 23 });
    expect(r23.success).toBe(true);
  });

  it('rejects weeklySummaryDay outside 0-6 range', () => {
    const r7 = notificationPrefsSchema.safeParse({ weeklySummaryDay: 7 });
    expect(r7.success).toBe(false);

    const r0 = notificationPrefsSchema.safeParse({ weeklySummaryDay: 0 });
    expect(r0.success).toBe(true);

    const r6 = notificationPrefsSchema.safeParse({ weeklySummaryDay: 6 });
    expect(r6.success).toBe(true);
  });

  it('merges partial input with defaults correctly', () => {
    const r = notificationPrefsSchema.safeParse({ overdueDigestEnabled: true });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.overdueDigestEnabled).toBe(true);
      expect(r.data.overdueDigestHour).toBe(8);
      expect(r.data.weeklySummaryEnabled).toBe(false);
      expect(r.data.weeklySummaryDay).toBe(1);
      expect(r.data.weeklySummaryHour).toBe(8);
      expect(r.data.pushEnabled).toBe(true);
      expect(r.data.emailEnabled).toBe(false);
    }
  });
});
