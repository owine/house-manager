import { Badge } from '@/components/ui/badge';

export function WarrantyStatusBadge({ endsOn }: { endsOn: Date }) {
  const days = (endsOn.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  if (days < 0) {
    return <Badge variant="destructive">Expired</Badge>;
  }
  if (days < 60) {
    return (
      <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-400">
        Expiring soon
      </Badge>
    );
  }
  return <Badge variant="secondary">Active</Badge>;
}
