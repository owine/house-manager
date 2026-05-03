import { Skeleton } from '@/components/ui/skeleton';

export default function VendorsLoading() {
  return (
    <div className="mx-auto max-w-7xl">
      <Skeleton className="mb-6 h-10 w-48" />
      <div className="flex flex-col gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: stable static loading skeletons
          <Skeleton key={i} className="h-12" />
        ))}
      </div>
    </div>
  );
}
