import { z } from 'zod';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export const notificationPrefsSchema = z.object({
  pushEnabled: z.boolean().default(true),
  emailEnabled: z.boolean().default(false),
  quietStart: z.string().regex(TIME).nullable().default(null),
  quietEnd: z.string().regex(TIME).nullable().default(null),
  timezone: z.string().default('UTC'),
  overdueDigestEnabled: z.boolean().default(false),
  overdueDigestHour: z.number().int().min(0).max(23).default(8),
  weeklySummaryEnabled: z.boolean().default(false),
  weeklySummaryDay: z.number().int().min(0).max(6).default(1),
  weeklySummaryHour: z.number().int().min(0).max(23).default(8),
});

export type NotificationPrefs = z.infer<typeof notificationPrefsSchema>;

export const defaultNotificationPrefs: NotificationPrefs = {
  pushEnabled: true,
  emailEnabled: false,
  quietStart: null,
  quietEnd: null,
  timezone: 'UTC',
  overdueDigestEnabled: false,
  overdueDigestHour: 8,
  weeklySummaryEnabled: false,
  weeklySummaryDay: 1,
  weeklySummaryHour: 8,
};

/** Normalize whatever's stored in User.notificationPrefs (Json | null) to a typed object. */
export function readNotificationPrefs(raw: unknown): NotificationPrefs {
  const r = notificationPrefsSchema.safeParse(raw ?? {});
  return r.success ? r.data : defaultNotificationPrefs;
}
