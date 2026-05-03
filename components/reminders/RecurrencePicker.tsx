'use client';
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import type { Recurrence } from '@/lib/reminders/schema';

type Props = {
  defaultValue?: Recurrence;
  onChange: (rec: Recurrence) => void;
};

export function RecurrencePicker({ defaultValue, onChange }: Props) {
  const [kind, setKind] = useState<Recurrence['kind']>(defaultValue?.kind ?? 'interval');
  const [days, setDays] = useState(defaultValue?.kind === 'interval' ? defaultValue.days : 60);
  const [dayOfMonth, setDayOfMonth] = useState(
    defaultValue?.kind === 'monthly' ? defaultValue.dayOfMonth : 1,
  );
  const [month, setMonth] = useState(defaultValue?.kind === 'yearly' ? defaultValue.month : 1);
  const [day, setDay] = useState(defaultValue?.kind === 'yearly' ? defaultValue.day : 1);

  function emit(next: Recurrence) {
    onChange(next);
  }

  return (
    <fieldset className="rounded border border-border p-3">
      <legend className="px-1 text-sm font-medium">Recurrence</legend>

      <label className="mb-1.5 flex items-center gap-2">
        <input
          type="radio"
          checked={kind === 'interval'}
          onChange={() => {
            setKind('interval');
            emit({ kind: 'interval', days });
          }}
        />
        <span className="text-sm">Every</span>
        <Input
          type="number"
          min={1}
          max={3650}
          value={days}
          onChange={(e) => {
            const n = Number(e.target.value);
            setDays(n);
            if (kind === 'interval') emit({ kind: 'interval', days: n });
          }}
          className="w-20"
        />
        <span className="text-sm">days from last completion</span>
      </label>

      <label className="mb-1.5 flex items-center gap-2">
        <input
          type="radio"
          checked={kind === 'monthly'}
          onChange={() => {
            setKind('monthly');
            emit({ kind: 'monthly', dayOfMonth });
          }}
        />
        <span className="text-sm">Every month on day</span>
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
      </label>

      <label className="flex items-center gap-2">
        <input
          type="radio"
          checked={kind === 'yearly'}
          onChange={() => {
            setKind('yearly');
            emit({ kind: 'yearly', month, day });
          }}
        />
        <span className="text-sm">Every year on</span>
        <select
          value={month}
          onChange={(e) => {
            const n = Number(e.target.value);
            setMonth(n);
            if (kind === 'yearly') emit({ kind: 'yearly', month: n, day });
          }}
          className="rounded border border-input bg-background px-2 py-1 text-sm"
        >
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
            <option key={m} value={m}>
              {new Date(2026, m - 1, 1).toLocaleString('en-US', { month: 'long' })}
            </option>
          ))}
        </select>
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
      </label>
    </fieldset>
  );
}
