'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
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
import { Switch } from '@/components/ui/switch';
import type { Recurrence } from '@/lib/reminders/schema';

type Props = {
  defaultValue?: Recurrence;
  onChange: (rec: Recurrence) => void;
};

type NthWeek = 1 | 2 | 3 | 4 | -1;

// All picker state lives in one object so emit handlers can compute the next
// recurrence from a merged value (avoids the React stale-setState pitfall).
type State = {
  kind: Recurrence['kind'];
  every: number;
  unit: 'day' | 'week' | 'month' | 'year';
  weekdays: number[];
  dayOfMonth: number;
  monthlyLast: boolean;
  nthWeek: NthWeek;
  nthWeekday: number;
  yearMonth: number;
  yearDay: number;
  seasonEnabled: boolean;
  activeMonths: number[];
};

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_LABELS = MONTHS.map((m) =>
  new Date(2026, m - 1, 1).toLocaleString('en-US', { month: 'short' }),
);
const NTH_WEEKS: { label: string; value: NthWeek }[] = [
  { label: 'First', value: 1 },
  { label: 'Second', value: 2 },
  { label: 'Third', value: 3 },
  { label: 'Fourth', value: 4 },
  { label: 'Last', value: -1 },
];

/** Clamp a raw input string to an integer within [min, max]; never NaN. */
function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Recurrence members for which the UI exposes seasonality. `once` (no
// activeMonths field) and `yearly` (hidden by spec) are deliberately excluded,
// so the spread below is provably type-safe with no cast.
type SeasonalRecurrence = Extract<
  Recurrence,
  { kind: 'interval' | 'weekly' | 'monthly' | 'monthlyWeekday' }
>;

function withSeason<R extends SeasonalRecurrence>(rec: R, s: State): R {
  if (s.seasonEnabled && s.activeMonths.length > 0) {
    return { ...rec, activeMonths: s.activeMonths };
  }
  return rec;
}

function buildRecurrence(s: State): Recurrence {
  switch (s.kind) {
    case 'interval':
      return withSeason({ kind: 'interval', every: s.every, unit: s.unit }, s);
    case 'weekly':
      return withSeason({ kind: 'weekly', weekdays: s.weekdays }, s);
    case 'monthly':
      return withSeason({ kind: 'monthly', dayOfMonth: s.monthlyLast ? 'last' : s.dayOfMonth }, s);
    case 'monthlyWeekday':
      return withSeason({ kind: 'monthlyWeekday', week: s.nthWeek, weekday: s.nthWeekday }, s);
    case 'yearly':
      // Seasonality is hidden for `yearly` per spec; never folded in.
      return { kind: 'yearly', month: s.yearMonth, day: s.yearDay };
    default:
      return { kind: 'once' };
  }
}

function initialState(dv?: Recurrence): State {
  const seasonMonths = dv && 'activeMonths' in dv ? (dv.activeMonths ?? []) : [];
  return {
    kind: dv?.kind ?? 'interval',
    every: dv?.kind === 'interval' ? dv.every : 60,
    unit: dv?.kind === 'interval' ? dv.unit : 'day',
    weekdays: dv?.kind === 'weekly' ? dv.weekdays : [1],
    dayOfMonth: dv?.kind === 'monthly' && dv.dayOfMonth !== 'last' ? dv.dayOfMonth : 1,
    monthlyLast: dv?.kind === 'monthly' && dv.dayOfMonth === 'last',
    nthWeek: dv?.kind === 'monthlyWeekday' ? dv.week : 1,
    nthWeekday: dv?.kind === 'monthlyWeekday' ? dv.weekday : 1,
    yearMonth: dv?.kind === 'yearly' ? dv.month : 1,
    yearDay: dv?.kind === 'yearly' ? dv.day : 1,
    seasonEnabled: seasonMonths.length > 0,
    activeMonths: seasonMonths,
  };
}

/** Toggle-row of Buttons used for both weekday and month multi-selects. */
function ToggleRow({
  options,
  selected,
  onToggle,
  ariaLabel,
}: {
  options: { label: string; value: number }[];
  selected: number[];
  onToggle: (value: number) => void;
  ariaLabel: string;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a non-fieldset toggle group inside an existing fieldset; role="group" is the correct ARIA pattern
    <div className="flex flex-wrap gap-1" role="group" aria-label={ariaLabel}>
      {options.map((opt) => {
        const on = selected.includes(opt.value);
        return (
          <Button
            key={opt.value}
            type="button"
            size="sm"
            variant={on ? 'default' : 'outline'}
            aria-pressed={on}
            onClick={() => onToggle(opt.value)}
          >
            {opt.label}
          </Button>
        );
      })}
    </div>
  );
}

export function RecurrencePicker({ defaultValue, onChange }: Props) {
  const [state, setState] = useState<State>(() => initialState(defaultValue));

  // Merge a partial update into state and emit the resulting recurrence from
  // the merged value (not the stale closure) in a single functional update.
  function update(patch: Partial<State>) {
    setState((prev) => {
      const next = { ...prev, ...patch };
      onChange(buildRecurrence(next));
      return next;
    });
  }

  const onKindChange = (next: string | null) => {
    if (next == null) return;
    update({ kind: next as Recurrence['kind'] });
  };

  const toggleWeekday = (value: number) => {
    setState((prev) => {
      const has = prev.weekdays.includes(value);
      // Never emit an empty weekdays array — keep the last one selected.
      if (has && prev.weekdays.length === 1) return prev;
      const weekdays = has
        ? prev.weekdays.filter((d) => d !== value)
        : [...prev.weekdays, value].sort((a, b) => a - b);
      const next = { ...prev, weekdays };
      onChange(buildRecurrence(next));
      return next;
    });
  };

  const toggleMonth = (value: number) => {
    setState((prev) => {
      const has = prev.activeMonths.includes(value);
      const activeMonths = has
        ? prev.activeMonths.filter((m) => m !== value)
        : [...prev.activeMonths, value].sort((a, b) => a - b);
      const next = { ...prev, activeMonths };
      onChange(buildRecurrence(next));
      return next;
    });
  };

  const showSeasonality = state.kind !== 'once' && state.kind !== 'yearly';

  return (
    <fieldset className="rounded border border-border p-3">
      <legend className="px-1 text-sm font-medium">Recurrence</legend>

      <RadioGroup value={state.kind} onValueChange={onKindChange} className="gap-2.5">
        {/* interval */}
        <div className="flex items-center gap-2">
          <RadioGroupItem id="recur-interval" value="interval" />
          <Label htmlFor="recur-interval" className="text-sm font-normal">
            Every
          </Label>
          <Input
            type="number"
            min={1}
            max={3650}
            value={state.every}
            onChange={(e) => update({ every: clampInt(e.target.value, 1, 3650, 1) })}
            className="w-20"
          />
          <Select value={state.unit} onValueChange={(v) => update({ unit: v as State['unit'] })}>
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="day">days</SelectItem>
              <SelectItem value="week">weeks</SelectItem>
              <SelectItem value="month">months</SelectItem>
              <SelectItem value="year">years</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-sm">from last completion</span>
        </div>

        {/* weekly */}
        <div className="flex flex-wrap items-center gap-2">
          <RadioGroupItem id="recur-weekly" value="weekly" />
          <Label htmlFor="recur-weekly" className="text-sm font-normal">
            Every week on:
          </Label>
          <ToggleRow
            options={WEEKDAYS.map((d) => ({ label: WEEKDAY_LABELS[d], value: d }))}
            selected={state.weekdays}
            onToggle={toggleWeekday}
            ariaLabel="Weekdays"
          />
        </div>

        {/* monthly */}
        <div className="flex flex-wrap items-center gap-2">
          <RadioGroupItem id="recur-monthly" value="monthly" />
          <Label htmlFor="recur-monthly" className="text-sm font-normal">
            Every month on day
          </Label>
          <Input
            type="number"
            min={1}
            max={28}
            value={state.dayOfMonth}
            disabled={state.monthlyLast}
            onChange={(e) => update({ dayOfMonth: clampInt(e.target.value, 1, 28, 1) })}
            className="w-16"
          />
          <span className="text-xs text-muted-foreground">(1–28)</span>
          <div className="flex items-center gap-2">
            <Switch
              id="recur-monthly-last"
              checked={state.monthlyLast}
              onCheckedChange={(c) => update({ monthlyLast: c })}
            />
            <Label htmlFor="recur-monthly-last" className="text-sm font-normal">
              Last day of month
            </Label>
          </div>
        </div>

        {/* monthlyWeekday */}
        <div className="flex flex-wrap items-center gap-2">
          <RadioGroupItem id="recur-monthly-weekday" value="monthlyWeekday" />
          <Label htmlFor="recur-monthly-weekday" className="text-sm font-normal">
            On the
          </Label>
          <Select
            value={String(state.nthWeek)}
            onValueChange={(v) => update({ nthWeek: Number(v) as NthWeek })}
          >
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {NTH_WEEKS.map((w) => (
                <SelectItem key={w.value} value={String(w.value)}>
                  {w.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={String(state.nthWeekday)}
            onValueChange={(v) => update({ nthWeekday: Number(v) })}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WEEKDAYS.map((d) => (
                <SelectItem key={d} value={String(d)}>
                  {WEEKDAY_LONG[d]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-sm">of every month</span>
        </div>

        {/* yearly */}
        <div className="flex flex-wrap items-center gap-2">
          <RadioGroupItem id="recur-yearly" value="yearly" />
          <Label htmlFor="recur-yearly" className="text-sm font-normal">
            Every year on
          </Label>
          <Select
            value={String(state.yearMonth)}
            onValueChange={(v) => update({ yearMonth: Number(v) })}
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
            value={state.yearDay}
            onChange={(e) => update({ yearDay: clampInt(e.target.value, 1, 28, 1) })}
            className="w-16"
          />
        </div>

        {/* once */}
        <div className="flex items-center gap-2">
          <RadioGroupItem id="recur-once" value="once" />
          <Label htmlFor="recur-once" className="text-sm font-normal">
            Once on the due date (does not repeat)
          </Label>
        </div>
      </RadioGroup>

      {showSeasonality && (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          <div className="flex items-center gap-2">
            <Switch
              id="recur-seasonal"
              checked={state.seasonEnabled}
              onCheckedChange={(c) => update({ seasonEnabled: c })}
            />
            <Label htmlFor="recur-seasonal" className="text-sm font-normal">
              Only certain months (seasonal)
            </Label>
          </div>
          {state.seasonEnabled && (
            <ToggleRow
              options={MONTHS.map((m) => ({ label: MONTH_LABELS[m - 1], value: m }))}
              selected={state.activeMonths}
              onToggle={toggleMonth}
              ariaLabel="Active months"
            />
          )}
        </div>
      )}
    </fieldset>
  );
}
