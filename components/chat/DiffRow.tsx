import { Badge } from '@/components/ui/badge';

/**
 * One field in a proposal diff. `before` is the record's current value —
 * omit it (undefined) for CREATE kinds, which have no prior state. When
 * present, it renders struck through ahead of the proposed value.
 */
export type DiffRowProps = {
  label: string;
  before?: string;
  after: string;
  source?: 'user' | 'inferred';
};

export function DiffRow({ label, before, after, source }: DiffRowProps) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <span className="flex flex-wrap items-center gap-1.5">
        {before !== undefined && (
          <>
            <span className="text-muted-foreground line-through">{before}</span>
            <span aria-hidden="true">&rarr;</span>
          </>
        )}
        <span className="font-medium">{after}</span>
        {source === 'inferred' && <Badge variant="outline">inferred</Badge>}
      </span>
    </div>
  );
}
