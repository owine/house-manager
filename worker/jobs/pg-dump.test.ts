import { describe, expect, it } from 'vitest';
import { RETENTION_COUNT, selectFilesToPrune } from './pg-dump';

describe('selectFilesToPrune', () => {
  it('returns empty when count <= retention', () => {
    const files = [
      { name: 'housemanager-2026-05-03T03-00-00Z.dump', mtimeMs: 1_000_000 },
      { name: 'housemanager-2026-05-02T03-00-00Z.dump', mtimeMs: 900_000 },
    ];
    expect(selectFilesToPrune(files)).toEqual([]);
  });

  it('keeps the newest RETENTION_COUNT and returns the rest for deletion', () => {
    const files = Array.from({ length: 10 }, (_, i) => ({
      name: `housemanager-day-${i}.dump`,
      mtimeMs: 1_000_000 - i * 1000, // index 0 is newest
    }));
    const toPrune = selectFilesToPrune(files);
    expect(toPrune).toHaveLength(10 - RETENTION_COUNT);
    expect(toPrune.map((f) => f.name).sort()).toEqual(
      ['housemanager-day-7.dump', 'housemanager-day-8.dump', 'housemanager-day-9.dump'].sort(),
    );
  });

  it('handles unsorted input by mtime', () => {
    const files = [
      { name: 'old.dump', mtimeMs: 100 },
      { name: 'new.dump', mtimeMs: 1000 },
      { name: 'middle.dump', mtimeMs: 500 },
    ];
    expect(selectFilesToPrune(files)).toEqual([]);
  });
});
