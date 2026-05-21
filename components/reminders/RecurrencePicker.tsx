'use client';
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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
type Combo = { week: NthWeek; weekday: number };
type MonthDay = { month: number; day: number };

// All picker state lives in one object so emit handlers can compute the next
// recurrence from a merged value (avoids the React stale-setState pitfall).
type State = {
  kind: Recurrence['kind'];
  every: number;
  unit: 'day' | 'week' | 'month' | 'year';
  weekdays: number[];
  weeklyInterval: number; // 1 = every week
  monthlyDays: number[];
  monthlyLast: boolean;
  monthlyDayInput: number; // transient "add day" field
  nthCombos: Combo[];
  nthWeekInput: NthWeek; // transient
  nthWeekdayInput: number; // transient
  yearlyDates: MonthDay[];
  seasonEnabled: boolean;
  activeMonths: number[];
};

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_SHORT = MONTHS.map((m) =>
  new Date(2026, m - 1, 1).toLocaleString('en-US', { month: 'short' }),
);
const MONTH_LONG = MONTHS.map((m) =>
  new Date(2026, m - 1, 1).toLocaleString('en-US', { month: 'long' }),
);
// Hardcoded month lengths; Feb shows 29 (runtime clamps impossible days).
const MONTH_LENGTHS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
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
      return withSeason({ kind: 'weekly', weekdays: s.weekdays, interval: s.weeklyInterval }, s);
    case 'monthly':
      return withSeason(
        { kind: 'monthly', days: [...s.monthlyDays].sort((a, b) => a - b), last: s.monthlyLast },
        s,
      );
    case 'monthlyWeekday':
      return withSeason({ kind: 'monthlyWeekday', combos: s.nthCombos }, s);
    case 'yearly':
      // Seasonality is hidden for `yearly` per spec; never folded in.
      return { kind: 'yearly', dates: s.yearlyDates };
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
    weeklyInterval: dv?.kind === 'weekly' ? dv.interval : 1,
    monthlyDays: dv?.kind === 'monthly' ? dv.days : [1],
    monthlyLast: dv?.kind === 'monthly' ? dv.last : false,
    monthlyDayInput: 1,
    nthCombos: dv?.kind === 'monthlyWeekday' ? dv.combos : [{ week: 1, weekday: 1 }],
    nthWeekInput: 1,
    nthWeekdayInput: 1,
    yearlyDates: dv?.kind === 'yearly' ? dv.dates : [{ month: 1, day: 1 }],
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

/** A removable chip used by monthly/monthlyWeekday/yearly multi-value rows. */
function Chip({
  label,
  onRemove,
  ariaLabel,
}: {
  label: string;
  onRemove: () => void;
  ariaLabel: string;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs">
      {label}
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={ariaLabel}
        onClick={onRemove}
        className="rounded-full"
      >
        <XIcon />
      </Button>
    </span>
  );
}

export function RecurrencePicker({ defaultValue, onChange }: Props) {
  const [state, setState] = useState<State>(() => initialState(defaultValue));
  const [yearlyOpen, setYearlyOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(1);

  // Merge a partial update into state, then emit the resulting recurrence — both
  // derived from the same `next` value, in the event handler (never inside the
  // setState updater, which would update the parent Controller during render).
  function update(patch: Partial<State>) {
    const next = { ...state, ...patch };
    setState(next);
    onChange(buildRecurrence(next));
  }

  const onKindChange = (next: string | null) => {
    if (next == null) return;
    update({ kind: next as Recurrence['kind'] });
  };

  const toggleWeekday = (value: number) => {
    const has = state.weekdays.includes(value);
    // Never emit an empty weekdays array — keep the last one selected.
    if (has && state.weekdays.length === 1) return;
    const weekdays = has
      ? state.weekdays.filter((d) => d !== value)
      : [...state.weekdays, value].sort((a, b) => a - b);
    update({ weekdays });
  };

  const toggleMonth = (value: number) => {
    const has = state.activeMonths.includes(value);
    const activeMonths = has
      ? state.activeMonths.filter((m) => m !== value)
      : [...state.activeMonths, value].sort((a, b) => a - b);
    // Auto-disable the seasonal switch when the last active month is removed,
    // so it can never sit "on" with zero months (a confusing silent no-op).
    update({
      activeMonths,
      seasonEnabled: activeMonths.length > 0 ? state.seasonEnabled : false,
    });
  };

  // monthly multi-day -------------------------------------------------------
  const addMonthlyDay = () => {
    const d = state.monthlyDayInput;
    if (d < 1 || d > 28 || state.monthlyDays.includes(d)) return;
    update({ monthlyDays: [...state.monthlyDays, d].sort((a, b) => a - b) });
  };
  const removeMonthlyDay = (d: number) => {
    // Don't strand monthly with no days while `last` is off (schema refine).
    if (state.monthlyDays.length === 1 && !state.monthlyLast) return;
    update({ monthlyDays: state.monthlyDays.filter((x) => x !== d) });
  };
  const setMonthlyLast = (c: boolean) => {
    // Turning off last-of-month while there are zero days would emit invalid
    // state; force at least day 1 back in.
    if (!c && state.monthlyDays.length === 0) {
      update({ monthlyLast: false, monthlyDays: [1] });
      return;
    }
    update({ monthlyLast: c });
  };

  // monthlyWeekday combos ---------------------------------------------------
  const addCombo = () => {
    const key = `${state.nthWeekInput}:${state.nthWeekdayInput}`;
    if (state.nthCombos.some((c) => `${c.week}:${c.weekday}` === key)) return;
    update({
      nthCombos: [...state.nthCombos, { week: state.nthWeekInput, weekday: state.nthWeekdayInput }],
    });
  };
  const removeCombo = (combo: Combo) => {
    if (state.nthCombos.length === 1) return; // keep ≥1
    update({
      nthCombos: state.nthCombos.filter(
        (c) => !(c.week === combo.week && c.weekday === combo.weekday),
      ),
    });
  };

  // yearly dates ------------------------------------------------------------
  const addYearlyDate = (month: number, day: number) => {
    const key = `${month}:${day}`;
    if (state.yearlyDates.some((d) => `${d.month}:${d.day}` === key)) return;
    update({ yearlyDates: [...state.yearlyDates, { month, day }] });
  };
  const removeYearlyDate = (date: MonthDay) => {
    if (state.yearlyDates.length === 1) return; // keep ≥1
    update({
      yearlyDates: state.yearlyDates.filter((d) => !(d.month === date.month && d.day === date.day)),
    });
  };

  const nthWeekItems = NTH_WEEKS.map((w) => ({ label: w.label, value: String(w.value) }));
  const weekdayItems = WEEKDAYS.map((d) => ({ label: WEEKDAY_LONG[d], value: String(d) }));

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
            Every
          </Label>
          <Input
            type="number"
            min={1}
            max={52}
            value={state.weeklyInterval}
            onChange={(e) => update({ weeklyInterval: clampInt(e.target.value, 1, 52, 1) })}
            className="w-16"
            aria-label="Weeks between occurrences"
          />
          <span className="text-sm">week(s) on:</span>
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
            value={state.monthlyDayInput}
            onChange={(e) => update({ monthlyDayInput: clampInt(e.target.value, 1, 28, 1) })}
            className="w-16"
            aria-label="Day of month to add"
          />
          <span className="text-xs text-muted-foreground">(1–28)</span>
          <Button type="button" size="sm" variant="outline" onClick={addMonthlyDay}>
            Add
          </Button>
          {/* biome-ignore lint/a11y/useSemanticElements: chip list of selected days; role="group" is correct here */}
          <div className="flex flex-wrap gap-1" role="group" aria-label="Selected days of month">
            {[...state.monthlyDays]
              .sort((a, b) => a - b)
              .map((d) => (
                <Chip
                  key={d}
                  label={String(d)}
                  ariaLabel={`Remove day ${d}`}
                  onRemove={() => removeMonthlyDay(d)}
                />
              ))}
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="recur-monthly-last"
              checked={state.monthlyLast}
              onCheckedChange={setMonthlyLast}
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
            items={nthWeekItems}
            value={String(state.nthWeekInput)}
            onValueChange={(v) => update({ nthWeekInput: Number(v ?? 1) as NthWeek })}
          >
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {nthWeekItems.map((it) => (
                <SelectItem key={it.value} value={it.value}>
                  {it.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            items={weekdayItems}
            value={String(state.nthWeekdayInput)}
            onValueChange={(v) => update({ nthWeekdayInput: Number(v ?? 0) })}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {weekdayItems.map((it) => (
                <SelectItem key={it.value} value={it.value}>
                  {it.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button type="button" size="sm" variant="outline" onClick={addCombo}>
            Add
          </Button>
          {/* biome-ignore lint/a11y/useSemanticElements: chip list of nth-weekday combos; role="group" is correct here */}
          <div
            className="flex flex-wrap gap-1"
            role="group"
            aria-label="Selected nth-weekday combos"
          >
            {state.nthCombos.map((c) => {
              const label = `${NTH_WEEKS.find((w) => w.value === c.week)?.label ?? c.week} ${WEEKDAY_LONG[c.weekday]}`;
              return (
                <Chip
                  key={`${c.week}:${c.weekday}`}
                  label={label}
                  ariaLabel={`Remove ${label}`}
                  onRemove={() => removeCombo(c)}
                />
              );
            })}
          </div>
        </div>

        {/* yearly */}
        <div className="flex flex-wrap items-center gap-2">
          <RadioGroupItem id="recur-yearly" value="yearly" />
          <Label htmlFor="recur-yearly" className="text-sm font-normal">
            Every year on
          </Label>
          {/* biome-ignore lint/a11y/useSemanticElements: chip list of yearly dates; role="group" is correct here */}
          <div className="flex flex-wrap gap-1" role="group" aria-label="Selected dates">
            {state.yearlyDates.map((d) => {
              const label = `${MONTH_SHORT[d.month - 1]} ${d.day}`;
              return (
                <Chip
                  key={`${d.month}:${d.day}`}
                  label={label}
                  ariaLabel={`Remove ${label}`}
                  onRemove={() => removeYearlyDate(d)}
                />
              );
            })}
          </div>
          <Popover open={yearlyOpen} onOpenChange={setYearlyOpen}>
            <PopoverTrigger
              render={
                <Button type="button" size="sm" variant="outline">
                  Add date
                </Button>
              }
            />
            <PopoverContent className="w-64">
              <div className="mb-2 flex items-center justify-between">
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Previous month"
                  onClick={() => setViewMonth((m) => (m === 1 ? 12 : m - 1))}
                >
                  <ChevronLeftIcon />
                </Button>
                <span className="text-sm font-medium">{MONTH_LONG[viewMonth - 1]}</span>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Next month"
                  onClick={() => setViewMonth((m) => (m === 12 ? 1 : m + 1))}
                >
                  <ChevronRightIcon />
                </Button>
              </div>
              <div className="flex flex-wrap gap-1">
                {Array.from({ length: MONTH_LENGTHS[viewMonth - 1] }, (_, i) => i + 1).map(
                  (day) => (
                    <Button
                      key={day}
                      type="button"
                      size="icon-sm"
                      variant="outline"
                      onClick={() => addYearlyDate(viewMonth, day)}
                    >
                      {day}
                    </Button>
                  ),
                )}
              </div>
            </PopoverContent>
          </Popover>
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
              onCheckedChange={(c) =>
                update({ seasonEnabled: c, ...(c ? {} : { activeMonths: [] }) })
              }
            />
            <Label htmlFor="recur-seasonal" className="text-sm font-normal">
              Only certain months (seasonal)
            </Label>
          </div>
          {state.seasonEnabled && (
            <ToggleRow
              options={MONTHS.map((m) => ({ label: MONTH_SHORT[m - 1], value: m }))}
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
