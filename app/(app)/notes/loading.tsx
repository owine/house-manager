import { Skeleton } from '@/components/ui/skeleton';

export default function NotesLoading() {
  return (
    <div className="mx-auto max-w-7xl">
      <Skeleton className="mb-6 h-10 w-48" />
      <Skeleton className="mb-4 h-8 w-72" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: stable static loading skeletons
          <div key={i} className="flex flex-col gap-2 rounded-xl border p-4">
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="mt-2 h-14 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
