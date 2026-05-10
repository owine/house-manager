import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Dashboard' };

import { auth } from '@/lib/auth';
import { quickStats, recentActivity, upcomingReminders } from '@/lib/dashboard/queries';
import { DashboardGreeting } from './DashboardGreeting';
import { OverviewStatsCard } from './OverviewStatsCard';
import { QuickActionsCard } from './QuickActionsCard';
import { RecentActivityList } from './RecentActivityList';
import { SeasonalChecklistCard } from './SeasonalChecklistCard';
import { UpcomingRemindersCard } from './UpcomingRemindersCard';

export default async function Dashboard() {
  const [session, stats, activity, reminders] = await Promise.all([
    auth(),
    quickStats(),
    recentActivity(10),
    upcomingReminders(5),
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
        <RecentActivityList activity={activity} />
      </div>

      <SeasonalChecklistCard />
    </div>
  );
}
