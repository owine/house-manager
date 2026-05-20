'use client';
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Recurrence } from '@/lib/reminders/schema';

type Props = {
  defaultValue?: Recurrence;
  onChange: (rec: Recurrence) => void;
};

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

export function RecurrencePicker({ defaultValue, onChange }: Props) {
  const [kind, setKind] = useState<Recurrence['kind']>(defaultValue?.kind ?? 'interval');
  const [days, setDays] = useState(defaultValue?.kind === 'interval' ? defaultValue.every : 60);
  const [dayOfMonth, setDayOfMonth] = useState(
    defaultValue?.kind === 'monthly' ? defaultValue.dayOfMonth : 1,
  );
  const [month, setMonth] = useState(defaultValue?.kind === 'yearly' ? defaultValue.month : 1);
  const [day, setDay] = useState(defaultValue?.kind === 'yearly' ? defaultValue.day : 1);

  function emit(next: Recurrence) {
    onChange(next);
  }

  const onKindChange = (next: string | null) => {
    if (next !== 'interval' && next !== 'monthly' && next !== 'yearly' && next !== 'once') return;
    setKind(next);
    if (next === 'interval') emit({ kind: 'interval', every: days, unit: 'day' });
    else if (next === 'monthly') emit({ kind: 'monthly', dayOfMonth });
    else if (next === 'yearly') emit({ kind: 'yearly', month, day });
    else emit({ kind: 'once' });
  };

  return (
    <fieldset className="rounded border border-border p-3">
      <legend className="px-1 text-sm font-medium">Recurrence</legend>

      <RadioGroup value={kind} onValueChange={onKindChange} className="gap-2.5">
        <div className="flex items-center gap-2">
          <RadioGroupItem id="recur-interval" value="interval" />
          <Label htmlFor="recur-interval" className="text-sm font-normal">
            Every
          </Label>
          <Input
            type="number"
            min={1}
            max={3650}
            value={days}
            onChange={(e) => {
              const n = Number(e.target.value);
              setDays(n);
              if (kind === 'interval') emit({ kind: 'interval', every: n, unit: 'day' });
            }}
            className="w-20"
          />
          <span className="text-sm">days from last completion</span>
        </div>

        <div className="flex items-center gap-2">
          <RadioGroupItem id="recur-monthly" value="monthly" />
          <Label htmlFor="recur-monthly" className="text-sm font-normal">
            Every month on day
          </Label>
          <Input
            type="number"
            min={1}
            max={28}
            value={dayOfMonth}
            onChange={(e) => {
              const n = Number(e.target.value);
              setDayOfMonth(n);
              if (kind === 'monthly') emit({ kind: 'monthly', dayOfMonth: n });
            }}
            className="w-16"
          />
          <span className="text-xs text-muted-foreground">(1–28)</span>
        </div>

        <div className="flex items-center gap-2">
          <RadioGroupItem id="recur-yearly" value="yearly" />
          <Label htmlFor="recur-yearly" className="text-sm font-normal">
            Every year on
          </Label>
          <Select
            items={MONTHS.map((m) => ({
              label: new Date(2026, m - 1, 1).toLocaleString('en-US', { month: 'long' }),
              value: String(m),
            }))}
            value={String(month)}
            onValueChange={(v) => {
              const n = Number(v);
              setMonth(n);
              if (kind === 'yearly') emit({ kind: 'yearly', month: n, day });
            }}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MONTHS.map((m) => (
                <SelectItem key={m} value={String(m)}>
                  {new Date(2026, m - 1, 1).toLocaleString('en-US', { month: 'long' })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            type="number"
            min={1}
            max={28}
            value={day}
            onChange={(e) => {
              const n = Number(e.target.value);
              setDay(n);
              if (kind === 'yearly') emit({ kind: 'yearly', month, day: n });
            }}
            className="w-16"
          />
        </div>

        <div className="flex items-center gap-2">
          <RadioGroupItem id="recur-once" value="once" />
          <Label htmlFor="recur-once" className="text-sm font-normal">
            Once on the due date (does not repeat)
          </Label>
        </div>
      </RadioGroup>
    </fieldset>
  );
}
