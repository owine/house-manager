import { describe, expect, it } from 'vitest';
import { withWeeklyAnchor } from './anchor';

describe('withWeeklyAnchor', () => {
  const due = new Date('2026-05-19T00:00:00Z'); // Tue
  it('sets anchor on weekly interval > 1', () => {
    const r = withWeeklyAnchor({ kind: 'weekly', weekdays: [2], interval: 2 }, due);
    expect(r).toEqual({ kind: 'weekly', weekdays: [2], interval: 2, anchor: '2026-05-19' });
  });
  it('leaves interval 1 weekly untouched (no anchor)', () => {
    const r = withWeeklyAnchor({ kind: 'weekly', weekdays: [2], interval: 1 }, due);
    expect(r).toEqual({ kind: 'weekly', weekdays: [2], interval: 1 });
  });
  it('passes through non-weekly kinds unchanged', () => {
    const r = withWeeklyAnchor({ kind: 'monthly', days: [1], last: false }, due);
    expect(r).toEqual({ kind: 'monthly', days: [1], last: false });
  });
});
