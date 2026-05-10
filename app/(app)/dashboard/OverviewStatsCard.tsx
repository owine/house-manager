import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { QuickStats } from '@/lib/dashboard/queries';

type Props = { stats: QuickStats };

export function OverviewStatsCard({ stats }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Overview</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-2 sm:gap-4">
          <div className="flex min-w-0 flex-col items-center gap-1 text-center">
            <span className="text-2xl font-semibold">{stats.activeItems}</span>
            <span className="text-xs break-words text-muted-foreground">active items</span>
          </div>
          <div className="flex min-w-0 flex-col items-center gap-1 text-center">
            <span className="text-2xl font-semibold">{stats.vendors}</span>
            <span className="text-xs break-words text-muted-foreground">vendors</span>
          </div>
          <div className="flex min-w-0 flex-col items-center gap-1 text-center">
            <span className="text-2xl font-semibold">{stats.serviceThisYear}</span>
            <span
              className="text-xs break-words text-muted-foreground"
              title="Services performed this year"
            >
              services
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
