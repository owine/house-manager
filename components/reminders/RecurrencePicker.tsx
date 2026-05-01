'use client';
import { useState } from 'react';
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
    <fieldset
      style={{ border: '1px solid var(--border)', padding: '0.75rem', borderRadius: '4px' }}
    >
      <legend style={{ fontSize: '0.85rem' }}>Recurrence</legend>

      <label
        style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.4rem' }}
      >
        <input
          type="radio"
          checked={kind === 'interval'}
          onChange={() => {
            setKind('interval');
            emit({ kind: 'interval', days });
          }}
        />
        Every
        <input
          type="number"
          min={1}
          max={3650}
          value={days}
          onChange={(e) => {
            const n = Number(e.target.value);
            setDays(n);
            if (kind === 'interval') emit({ kind: 'interval', days: n });
          }}
          style={{ width: '5rem' }}
        />
        days from last completion
      </label>

      <label
        style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.4rem' }}
      >
        <input
          type="radio"
          checked={kind === 'monthly'}
          onChange={() => {
            setKind('monthly');
            emit({ kind: 'monthly', dayOfMonth });
          }}
        />
        Every month on day
        <input
          type="number"
          min={1}
          max={28}
          value={dayOfMonth}
          onChange={(e) => {
            const n = Number(e.target.value);
            setDayOfMonth(n);
            if (kind === 'monthly') emit({ kind: 'monthly', dayOfMonth: n });
          }}
          style={{ width: '4rem' }}
        />
        <span style={{ color: 'var(--fg-muted)', fontSize: '0.8rem' }}>(1–28)</span>
      </label>

      <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
        <input
          type="radio"
          checked={kind === 'yearly'}
          onChange={() => {
            setKind('yearly');
            emit({ kind: 'yearly', month, day });
          }}
        />
        Every year on
        <select
          value={month}
          onChange={(e) => {
            const n = Number(e.target.value);
            setMonth(n);
            if (kind === 'yearly') emit({ kind: 'yearly', month: n, day });
          }}
        >
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
            <option key={m} value={m}>
              {new Date(2026, m - 1, 1).toLocaleString('en-US', { month: 'long' })}
            </option>
          ))}
        </select>
        <input
          type="number"
          min={1}
          max={28}
          value={day}
          onChange={(e) => {
            const n = Number(e.target.value);
            setDay(n);
            if (kind === 'yearly') emit({ kind: 'yearly', month, day: n });
          }}
          style={{ width: '4rem' }}
        />
      </label>
    </fieldset>
  );
}
