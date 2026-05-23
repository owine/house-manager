import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Worker-parity guard: every Queue.X declared in lib/queue.ts must have a
 * matching `boss.work(Queue.X, ...)` registration in worker/index.ts.
 *
 * Without this, you can add a new queue and a `boss.send(Queue.X, ...)`
 * caller, ship it, and have jobs accumulate forever in pg-boss's job
 * table with no consumer — and nothing fails loudly. The job rows just
 * sit there until someone notices the worker isn't handling them or
 * the table grows enough to show up in monitoring.
 */
describe('queue worker parity', () => {
  const repoRoot = process.cwd();
  const queueSrc = readFileSync(join(repoRoot, 'lib/queue.ts'), 'utf8');
  const workerSrc = readFileSync(join(repoRoot, 'worker/index.ts'), 'utf8');

  // Parse the `Queue` object literal — keys are the canonical names used in
  // `Queue.X` references. Regex is sufficient because the object is a flat
  // one-line-per-key literal; if that ever changes, this test fails loudly.
  function parseQueueKeys(): string[] {
    const block = queueSrc.match(/export const Queue\s*=\s*\{([\s\S]*?)\}\s*as const/);
    if (!block)
      throw new Error('Could not find `export const Queue = { ... } as const` in lib/queue.ts');
    const keys: string[] = [];
    for (const line of block[1].split('\n')) {
      const m = line.match(/^\s*([A-Z][A-Za-z0-9]*)\s*:/);
      if (m) keys.push(m[1]);
    }
    if (keys.length === 0) throw new Error('Queue object parsed to zero keys');
    return keys;
  }

  const keys = parseQueueKeys();

  it('every Queue.X has a boss.work(Queue.X) registration in worker/index.ts', () => {
    const missing: string[] = [];
    for (const k of keys) {
      // Match `boss.work(Queue.X` or `boss.work<...>(Queue.X` allowing generic
      // type args. Whitespace tolerant.
      const pattern = new RegExp(`boss\\.work\\s*(?:<[^>]*>)?\\s*\\(\\s*Queue\\.${k}\\b`);
      if (!pattern.test(workerSrc)) missing.push(k);
    }
    if (missing.length > 0) {
      throw new Error(
        `Queue keys with no boss.work(...) registration in worker/index.ts:\n${missing
          .map((k) => `  - Queue.${k}`)
          .join(
            '\n',
          )}\n\nAdd a handler in worker/index.ts or remove the unused queue from lib/queue.ts.`,
      );
    }
    expect(missing).toEqual([]);
  });

  it('worker/index.ts only references Queue keys that exist in lib/queue.ts', () => {
    // Catch the reverse drift: a handler registered against a renamed-away or
    // typo'd key. The TS compiler would catch a totally-missing identifier,
    // but renaming via search-replace could leave a stale string literal.
    const refs = Array.from(workerSrc.matchAll(/\bQueue\.([A-Z][A-Za-z0-9]*)\b/g)).map((m) => m[1]);
    const unknown = Array.from(new Set(refs)).filter((r) => !keys.includes(r));
    expect(unknown).toEqual([]);
  });
});
