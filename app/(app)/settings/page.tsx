import { HouseProfileForm } from '@/components/house-profile/HouseProfileForm';
import { CalendarPanel } from '@/components/notifications/CalendarPanel';
import { NotificationPrefsForm } from '@/components/notifications/NotificationPrefsForm';
import { PushSubscribeButton } from '@/components/notifications/PushSubscribeButton';
import { ThemeToggle } from '@/components/ThemeToggle';
import { getEnv } from '@/lib/env';
import { getHouseProfile } from '@/lib/house-profile/queries';
import type { HouseProfileInput } from '@/lib/house-profile/schema';
import { readNotificationPrefs } from '@/lib/notifications/prefs';
import { getCurrentUserSettings } from '@/lib/notifications/queries';

export default async function SettingsPage() {
  const profile = await getHouseProfile();
  const userSettings = await getCurrentUserSettings();
  const env = getEnv();

  const defaultValues: HouseProfileInput = {
    location: profile?.location ?? '',
    climateZone: profile?.climateZone ?? '',
    propertyType: (profile?.propertyType as HouseProfileInput['propertyType']) ?? undefined,
  };

  if (!userSettings) {
    return (
      <div>
        <h1>Settings</h1>
        <p>Unable to load settings. Please try again.</p>
      </div>
    );
  }

  return (
    <div>
      <h1>Settings</h1>
      <h2 style={{ fontSize: '1rem', margin: '1rem 0 0.5rem' }}>Theme</h2>
      <ThemeToggle />
      <h2 style={{ fontSize: '1rem', margin: '1.5rem 0 0.5rem' }}>House profile</h2>
      <HouseProfileForm defaultValues={defaultValues} />
      <h2 style={{ fontSize: '1rem', margin: '1.5rem 0 0.5rem' }}>Notifications</h2>
      <NotificationPrefsForm
        prefs={readNotificationPrefs(userSettings.notificationPrefs)}
        subscriptions={userSettings.pushSubscriptions}
      />
      <div style={{ marginTop: '1rem' }}>
        <PushSubscribeButton />
      </div>
      <h2 style={{ fontSize: '1rem', margin: '1.5rem 0 0.5rem' }}>Calendar</h2>
      <CalendarPanel icsToken={userSettings.icsToken} appUrl={env.APP_URL ?? ''} />
    </div>
  );
}
