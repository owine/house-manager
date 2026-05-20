import type { Recurrence } from './schema';

const WD_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WD_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON_SHORT = [
  '',
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
const MON_LONG = [
  '',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const WEEK_LABEL: Record<number, string> = {
  1: 'First',
  2: 'Second',
  3: 'Third',
  4: 'Fourth',
  [-1]: 'Last',
};

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

// True if each step from one month to the next is +1 modulo 12 (single unbroken run).
function consecutiveMod12(seq: number[]): boolean {
  for (let i = 1; i < seq.length; i++) {
    if ((seq[i] - seq[i - 1] + 12) % 12 !== 1) return false;
  }
  return true;
}

// Rotate a sorted set at its first gap so a wrap-around run becomes contiguous:
// [1,2,11,12] -> [11,12,1,2]. No gap -> returned as-is.
function rotateToWrap(sorted: number[]): number[] {
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] > 1) return [...sorted.slice(i), ...sorted.slice(0, i)];
  }
  return sorted;
}

function seasonSuffix(months: number[] | undefined): string {
  if (!months) return '';
  const sorted = [...months].sort((a, b) => a - b);
  if (sorted.length === 1) return ` (${MON_SHORT[sorted[0]]})`;
  if (consecutiveMod12(sorted)) {
    return ` (${MON_SHORT[sorted[0]]}–${MON_SHORT[sorted[sorted.length - 1]]})`;
  }
  const rot = rotateToWrap(sorted);
  if (consecutiveMod12(rot)) {
    return ` (${MON_SHORT[rot[0]]}–${MON_SHORT[rot[rot.length - 1]]})`;
  }
  return ` (${sorted.map((m) => MON_SHORT[m]).join(', ')})`;
}

export function describeRecurrence(rec: Recurrence): string {
  const season = 'activeMonths' in rec ? seasonSuffix(rec.activeMonths) : '';
  switch (rec.kind) {
    case 'once':
      return 'Once (does not repeat)';
    case 'interval': {
      const base = rec.every === 1 ? `Every ${rec.unit}` : `Every ${rec.every} ${rec.unit}s`;
      return base + season;
    }
    case 'weekly':
      return `Every ${rec.weekdays.map((d) => WD_SHORT[d]).join(' & ')}${season}`;
    case 'monthly':
      return (
        (rec.dayOfMonth === 'last'
          ? 'Last day of the month'
          : `Monthly on the ${ordinal(rec.dayOfMonth)}`) + season
      );
    case 'monthlyWeekday':
      return `${WEEK_LABEL[rec.week]} ${WD_LONG[rec.weekday]} of the month${season}`;
    case 'yearly':
      return `Every year on ${MON_LONG[rec.month]} ${rec.day}${season}`;
  }
}
