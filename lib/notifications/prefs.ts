import { z } from 'zod';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export const notificationPrefsSchema = z.object({
  pushEnabled: z.boolean().default(true),
  emailEnabled: z.boolean().default(false),
  quietStart: z.string().regex(TIME).nullable().default(null),
  quietEnd: z.string().regex(TIME).nullable().default(null),
  timezone: z.string().default('UTC'),
});

export type NotificationPrefs = z.infer<typeof notificationPrefsSchema>;

export const defaultNotificationPrefs: NotificationPrefs = {
  pushEnabled: true,
  emailEnabled: false,
  quietStart: null,
  quietEnd: null,
  timezone: 'UTC',
};

/** Normalize whatever's stored in User.notificationPrefs (Json | null) to a typed object. */
export function readNotificationPrefs(raw: unknown): NotificationPrefs {
  const r = notificationPrefsSchema.safeParse(raw ?? {});
  return r.success ? r.data : defaultNotificationPrefs;
}
