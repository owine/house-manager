import { DashboardShell } from '@/app/(app)/_components/DashboardShell';
import { auth } from '@/lib/auth';
import { quickStats, recentActivity, upcomingReminders } from '@/lib/dashboard/queries';
import { DashboardGreeting } from './DashboardGreeting';
import { DueSoonLane } from './DueSoonLane';
import { QuickActionsCard } from './QuickActionsCard';
import { RecentActivityList } from './RecentActivityList';
import { SeasonalChecklistCard } from './SeasonalChecklistCard';

export default async function Dashboard() {
  const [session, stats, activity, reminders] = await Promise.all([
    auth(),
    quickStats(),
    recentActivity(10),
    upcomingReminders(5),
  ]);

  return (
    <DashboardShell
      greeting={<DashboardGreeting name={session?.user?.name ?? 'there'} />}
      primary={<DueSoonLane stats={stats} reminders={reminders} />}
      secondary={[<QuickActionsCard key="qa" />, <SeasonalChecklistCard key="sc" />]}
      tertiary={<RecentActivityList activity={activity} />}
    />
  );
}
