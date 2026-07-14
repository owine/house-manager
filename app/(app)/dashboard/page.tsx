import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'dashboard' };

import { auth } from '@/lib/auth';
import { listChecklists } from '@/lib/checklists/queries';
import { quickStats, recentActivity, upcomingReminders } from '@/lib/dashboard/queries';
import { getHouseTimezone } from '@/lib/house-profile/queries';
import { listInboxEmails } from '@/lib/incoming-email/queries';
import { ActiveChecklistsCard } from './ActiveChecklistsCard';
import { DashboardGreeting } from './DashboardGreeting';
import { InboxPreviewCard } from './InboxPreviewCard';
import { OverviewStatsCard } from './OverviewStatsCard';
import { QuickActionsCard } from './QuickActionsCard';
import { RecentActivityList } from './RecentActivityList';
import { SeasonalChecklistCard } from './SeasonalChecklistCard';
import { UpcomingRemindersCard } from './UpcomingRemindersCard';

export default async function Dashboard() {
  const [session, stats, activity, reminders, checklists, inbox, tz] = await Promise.all([
    auth(),
    quickStats(await getHouseTimezone()),
    recentActivity(10),
    upcomingReminders(5),
    listChecklists(),
    listInboxEmails({ tab: 'untriaged', take: 5 }),
    getHouseTimezone(),
  ]);

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <DashboardGreeting name={session?.user?.name ?? 'there'} />

      {/* Launchpad band — primary CTAs as a wide strip at the top so the
          dashboard doubles as a "what do I want to do next" shortcut. */}
      <QuickActionsCard />

      <OverviewStatsCard stats={stats} />

      {/* What's pending vs what just happened. Activity on the right gets the
          taller column for long item names; reminders on the left is dense. */}
      <div className="grid gap-6 md:grid-cols-2">
        <UpcomingRemindersCard reminders={reminders} />
        <RecentActivityList activity={activity} tz={tz} />
      </div>

      <InboxPreviewCard emails={inbox} tz={tz} />

      <ActiveChecklistsCard checklists={checklists} />

      <SeasonalChecklistCard />
    </div>
  );
}
