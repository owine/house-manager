import { Skeleton } from '@/components/ui/skeleton';

export default function ServiceRecordDetailLoading() {
  return (
    <div className="mx-auto max-w-3xl">
      <Skeleton className="mb-6 h-10 w-64" />
      <div className="rounded-xl border p-6">
        <div className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: stable static loading skeletons
            <div key={i} className="contents">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-40" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
