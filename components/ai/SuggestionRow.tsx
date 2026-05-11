'use client';
import { Pencil } from 'lucide-react';
import { type Control, useController } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ProposedRecurrence, ProposedReminder } from '@/lib/ai/schemas';

// _selected and _editing are UI-only fields layered on top of the AI proposal.
type ReminderRow = ProposedReminder & { _selected: boolean; _editing: boolean };
type ChecklistRow = {
  title: string;
  itemId: string | null;
  rationale?: string;
  _selected: boolean;
  _editing: boolean;
};
type Row = ReminderRow | ChecklistRow;

type Props = {
  index: number;
  // Loose typing — parent owns the schema shape per kind.
  // biome-ignore lint/suspicious/noExplicitAny: form generic varies by kind
  control: Control<any>;
  kind: 'reminders' | 'checklist';
};

export function SuggestionRow({ index, control, kind }: Props) {
  const { field } = useController({ control, name: `proposals.${index}` });
  const row = field.value as Row;

  const onToggleSelect = (checked: boolean) => field.onChange({ ...row, _selected: checked });
  const onToggleEdit = () => field.onChange({ ...row, _editing: !row._editing });

  const rationale = (row as ReminderRow).rationale;

  return (
    <li className="flex items-start gap-3 border-b p-3 last:border-b-0">
      <Checkbox
        checked={row._selected}
        onCheckedChange={(c) => onToggleSelect(c === true)}
        aria-label={`Select ${row.title}`}
        className="mt-1"
      />
      <div className="flex-1 space-y-1">
        {row._editing ? (
          <Input
            value={row.title}
            onChange={(e) => field.onChange({ ...row, title: e.target.value })}
            className="font-medium"
          />
        ) : (
          <p className="font-medium">{row.title}</p>
        )}
        {kind === 'reminders' && (
          <RecurrenceLine
            recurrence={(row as ReminderRow).recurrence}
            editing={row._editing}
            onChange={(rec) => field.onChange({ ...row, recurrence: rec })}
          />
        )}
        {rationale && <p className="text-sm text-muted-foreground">{rationale}</p>}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onToggleEdit}
        aria-label={row._editing ? 'Done editing' : 'Edit row'}
      >
        <Pencil className="h-4 w-4" />
      </Button>
    </li>
  );
}

function RecurrenceLine(props: {
  recurrence: ProposedRecurrence;
  editing: boolean;
  onChange: (r: ProposedRecurrence) => void;
}) {
  const { recurrence, editing, onChange } = props;

  if (!editing) {
    return <p className="text-sm text-muted-foreground">{formatRecurrence(recurrence)}</p>;
  }

  return (
    <div className="flex items-center gap-2">
      <Select
        value={recurrence.kind}
        onValueChange={(kind) => onChange(defaultRecurrence(kind as ProposedRecurrence['kind']))}
      >
        <SelectTrigger className="h-8 w-[120px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="interval">Every N days</SelectItem>
          <SelectItem value="monthly">Monthly</SelectItem>
          <SelectItem value="yearly">Yearly</SelectItem>
        </SelectContent>
      </Select>
      {recurrence.kind === 'interval' && (
        <Input
          type="number"
          min={1}
          max={3650}
          value={recurrence.days}
          onChange={(e) => onChange({ kind: 'interval', days: Number(e.target.value) || 1 })}
          className="h-8 w-20"
          aria-label="Days"
        />
      )}
      {recurrence.kind === 'monthly' && (
        <Input
          type="number"
          min={1}
          max={28}
          value={recurrence.dayOfMonth}
          onChange={(e) => onChange({ kind: 'monthly', dayOfMonth: Number(e.target.value) || 1 })}
          className="h-8 w-20"
          aria-label="Day of month"
        />
      )}
      {recurrence.kind === 'yearly' && (
        <>
          <Input
            type="number"
            min={1}
            max={12}
            value={recurrence.month}
            onChange={(e) =>
              onChange({ ...recurrence, kind: 'yearly', month: Number(e.target.value) || 1 })
            }
            className="h-8 w-16"
            aria-label="Month"
          />
          <Input
            type="number"
            min={1}
            max={28}
            value={recurrence.day}
            onChange={(e) =>
              onChange({ ...recurrence, kind: 'yearly', day: Number(e.target.value) || 1 })
            }
            className="h-8 w-16"
            aria-label="Day"
          />
        </>
      )}
    </div>
  );
}

function formatRecurrence(r: ProposedRecurrence): string {
  if (r.kind === 'interval') return `Every ${r.days} days`;
  if (r.kind === 'monthly') return `Monthly on the ${r.dayOfMonth}${ordinalSuffix(r.dayOfMonth)}`;
  const month = MONTH_NAMES[r.month - 1] ?? '?';
  return `Yearly on ${month} ${r.day}`;
}

function ordinalSuffix(n: number): string {
  if (n >= 11 && n <= 13) return 'th';
  const last = n % 10;
  if (last === 1) return 'st';
  if (last === 2) return 'nd';
  if (last === 3) return 'rd';
  return 'th';
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function defaultRecurrence(kind: ProposedRecurrence['kind']): ProposedRecurrence {
  if (kind === 'interval') return { kind: 'interval', days: 30 };
  if (kind === 'monthly') return { kind: 'monthly', dayOfMonth: 1 };
  return { kind: 'yearly', month: 1, day: 1 };
}
