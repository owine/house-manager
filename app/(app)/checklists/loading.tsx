import { Skeleton } from '@/components/ui/skeleton';

export default function ChecklistsLoading() {
  return (
    <div className="mx-auto max-w-7xl">
      <Skeleton className="mb-6 h-10 w-48" />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: stable static loading skeletons
          <Skeleton key={i} className="h-32" />
        ))}
      </div>
    </div>
  );
}
