import { Skeleton } from '@/components/ui/skeleton';

export default function ServiceLoading() {
  return (
    <div className="mx-auto max-w-7xl">
      <Skeleton className="mb-6 h-10 w-56" />
      <Skeleton className="mb-4 h-8 w-96" />
      <div className="flex flex-col gap-2">
        {Array.from({ length: 8 }).map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: stable static loading skeletons
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}
