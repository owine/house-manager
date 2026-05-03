import { Skeleton } from '@/components/ui/skeleton';

export default function NoteDetailLoading() {
  return (
    <div className="mx-auto max-w-3xl">
      <Skeleton className="mb-6 h-10 w-64" />
      <Skeleton className="mb-4 h-5 w-48" />
      <div className="rounded-xl border p-6">
        <Skeleton className="mb-3 h-4 w-full" />
        <Skeleton className="mb-3 h-4 w-5/6" />
        <Skeleton className="mb-3 h-4 w-4/5" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    </div>
  );
}
