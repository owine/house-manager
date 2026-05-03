import { Skeleton } from '@/components/ui/skeleton';

export default function RemindersLoading() {
  return (
    <div className="mx-auto max-w-7xl">
      <Skeleton className="mb-6 h-10 w-48" />
      <div className="flex flex-col gap-0">
        <Skeleton className="h-10 rounded-b-none" />
        {Array.from({ length: 8 }).map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: stable static loading skeletons
          <Skeleton key={i} className="h-12 rounded-none border-t-0" />
        ))}
      </div>
    </div>
  );
}
