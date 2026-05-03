import { Skeleton } from '@/components/ui/skeleton';

export default function VendorDetailLoading() {
  return (
    <div className="mx-auto max-w-7xl">
      <Skeleton className="mb-6 h-10 w-64" />
      <div className="grid gap-6 md:grid-cols-3">
        <div className="md:col-span-2">
          <Skeleton className="mb-3 h-9" />
          <Skeleton className="h-96" />
        </div>
        <Skeleton className="h-64" />
      </div>
    </div>
  );
}
