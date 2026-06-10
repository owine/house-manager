import type { Metadata } from 'next';
import { FormPageShell } from '@/app/(app)/_components/FormPageShell';

export const metadata: Metadata = { title: 'settings' };

import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { HouseProfileForm } from '@/components/house-profile/HouseProfileForm';
import { CalendarPanel } from '@/components/notifications/CalendarPanel';
import { NotificationPrefsForm } from '@/components/notifications/NotificationPrefsForm';
import { PushSubscribeButton } from '@/components/notifications/PushSubscribeButton';
import { RebuildIndexButton } from '@/components/search/RebuildIndexButton';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
    timezone: profile?.timezone ?? 'UTC',
  };

  if (!userSettings) {
    return (
      <FormPageShell header={<PageHeader title="settings" />} maxWidth="3xl">
        <Card>
          <CardContent className="pt-6">
            <p className="text-muted-foreground">Unable to load settings. Please try again.</p>
          </CardContent>
        </Card>
      </FormPageShell>
    );
  }

  return (
    <FormPageShell header={<PageHeader title="settings" />} maxWidth="3xl">
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Theme</CardTitle>
            <CardDescription>Light, dark, or follow the system setting.</CardDescription>
          </CardHeader>
          <CardContent>
            <ThemeToggle />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>House profile</CardTitle>
            <CardDescription>
              Location and property type used for seasonal recommendations.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <HouseProfileForm defaultValues={defaultValues} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Notifications</CardTitle>
            <CardDescription>Choose how reminders reach you.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <NotificationPrefsForm
              prefs={readNotificationPrefs(userSettings.notificationPrefs)}
              subscriptions={userSettings.pushSubscriptions}
            />
            <PushSubscribeButton />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Calendar</CardTitle>
            <CardDescription>Subscribe to your reminders feed in any calendar app.</CardDescription>
          </CardHeader>
          <CardContent>
            <CalendarPanel icsToken={userSettings.icsToken} appUrl={env.APP_URL ?? ''} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Search</CardTitle>
            <CardDescription>
              Rebuild the search index if items aren't appearing in results.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RebuildIndexButton />
          </CardContent>
        </Card>
      </div>
    </FormPageShell>
  );
}
