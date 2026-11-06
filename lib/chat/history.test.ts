import { describe, expect, it } from 'vitest';
import { boundHistory, HISTORY_CHAR_BUDGET } from './history';

const u = (content: string) => ({ role: 'user' as const, content });
const a = (content: string) => ({ role: 'assistant' as const, content });

describe('boundHistory', () => {
  it('keeps a short thread whole', () => {
    const msgs = [u('hi'), a('hello'), u('add a note'), a('done')];
    expect(boundHistory(msgs)).toEqual(msgs);
  });

  it('caps a long session at the char budget, keeping the newest turns', () => {
    const msgs = Array.from({ length: 200 }, (_, i) =>
      i % 2 === 0 ? u(`q${i} ${'x'.repeat(7000)}`) : a(`r${i} ${'y'.repeat(3000)}`),
    );
    const out = boundHistory(msgs);
    const chars = out.reduce((n, m) => n + m.content.length, 0);
    expect(chars).toBeLessThanOrEqual(HISTORY_CHAR_BUDGET);
    expect(out.length).toBeGreaterThan(0);
    // The newest message is always the last one replayed.
    expect(out.at(-1)).toBe(msgs.at(-1));
    // A contiguous suffix: nothing skipped in the middle.
    expect(out).toEqual(msgs.slice(msgs.length - out.length));
  });

  it('starts on a user message', () => {
    // Budget fits the last three: a('r1'), u('q2'), a('r2'). The leading
    // assistant reply is dropped rather than sent first.
    const msgs = [u('q1'), a('r1'), u('q2'), a('r2')];
    const out = boundHistory(msgs, 6);
    expect(out).toEqual([u('q2'), a('r2')]);
  });

  it('replays nothing when even the newest message is over budget', () => {
    expect(boundHistory([u('q'), a('z'.repeat(50))], 10)).toEqual([]);
  });
});
