import { Skeleton } from '@/components/ui/skeleton';

export default function ReminderDetailLoading() {
  return (
    <div className="mx-auto max-w-3xl">
      <Skeleton className="mb-6 h-10 w-64" />
      <Skeleton className="mb-4 h-5 w-32" />
      <Skeleton className="mb-6 h-24" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-48" />
        <Skeleton className="h-48" />
      </div>
      <Skeleton className="mt-6 h-10 w-32" />
    </div>
  );
}
