import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Drift guard: every file that writes to an indexed Prisma model must also
 * enqueue a search-index upsert for that kind. Catches the bug class where
 * a new write path forgets to call `enqueueSearchIndex(...)` and silently
 * relies on the 3am nightly rebuild to backfill — see PR #175 for the
 * five real-world sites that motivated this test.
 *
 * File-level granularity: if a file does any indexed write for kind K, it
 * must contain at least one `enqueueSearchIndex('K', ...)` call. Whole-file
 * exemptions are listed in ALLOWED with a one-line reason.
 */

// Prisma model name → search kind string used in enqueueSearchIndex calls.
const KIND_BY_MODEL: Record<string, string> = {
  item: 'item',
  vendor: 'vendor',
  note: 'note',
  serviceRecord: 'service',
  reminder: 'reminder',
  attachment: 'attachment',
  checklist: 'checklist',
};

// Mutating Prisma client methods. `findX` / `count` / `aggregate` are reads
// and don't need indexing.
const WRITE_METHODS = [
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
];

// Documented exemptions: (file, kind) pairs that legitimately write without
// enqueueing. Keep this list short and annotated; every entry is a load-
// bearing comment explaining why the write doesn't change indexed fields.
const ALLOWED: { file: string; kind: string; reason: string }[] = [
  {
    file: 'worker/jobs/search-reindex.ts',
    kind: '*',
    reason: 'this IS the reindex job — it writes Meili directly, not via the enqueue path',
  },
  {
    file: 'lib/systems/actions.ts',
    kind: 'item',
    reason: 'only mutates Item.systemId, which is not in the Item search doc',
  },
  {
    file: 'lib/incoming-email/actions.ts',
    kind: 'attachment',
    reason:
      'updateMany only sets serviceRecordId to link inbox attachments to a service record; ' +
      'attachment search doc references the direct Item link, not serviceRecord',
  },
  {
    file: 'worker/jobs/thumbnail.ts',
    kind: 'attachment',
    reason: 'only writes thumbnailPath; not in the attachment search doc',
  },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === '.next' || name === 'dist') continue;
      walk(full, out);
    } else if (
      st.isFile() &&
      full.endsWith('.ts') &&
      !full.endsWith('.test.ts') &&
      !full.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

function isAllowed(file: string, kind: string): boolean {
  return ALLOWED.some((a) => a.file === file && (a.kind === '*' || a.kind === kind));
}

describe('search-index drift guard', () => {
  const repoRoot = process.cwd();
  const roots = ['lib', 'worker'].map((d) => join(repoRoot, d));
  const files = roots.flatMap((r) => walk(r));

  it('every file that writes to an indexed model also enqueues for that kind', () => {
    const violations: { file: string; kind: string; sample: string }[] = [];

    for (const fullPath of files) {
      const rel = relative(repoRoot, fullPath);
      const src = readFileSync(fullPath, 'utf8');

      for (const [model, kind] of Object.entries(KIND_BY_MODEL)) {
        // Match prisma.<model>.<method> or tx.<model>.<method> or
        // <anyIdentifier>.<model>.<method> (e.g. variant transaction clients).
        const writePattern = new RegExp(
          `\\b(?:prisma|tx|[a-zA-Z_$][\\w$]*)\\.${model}\\.(?:${WRITE_METHODS.join('|')})\\b`,
        );
        if (!writePattern.test(src)) continue;

        // Allowlist check — for documented false positives.
        if (isAllowed(rel, kind)) continue;

        // Must have at least one enqueueSearchIndex call for this kind.
        const enqueuePattern = new RegExp(`enqueueSearchIndex\\(\\s*['"\`]${kind}['"\`]`);
        if (!enqueuePattern.test(src)) {
          const match = src.match(writePattern);
          violations.push({
            file: rel,
            kind,
            sample: match?.[0] ?? '(unknown)',
          });
        }
      }
    }

    if (violations.length > 0) {
      const msg = violations
        .map(
          (v) =>
            `  ${v.file}: writes to "${v.kind}" via \`${v.sample}\` but never calls enqueueSearchIndex('${v.kind}', ...)`,
        )
        .join('\n');
      throw new Error(
        `Search-index drift detected. Each file that writes to an indexed Prisma model must also call enqueueSearchIndex(<kind>, id, 'upsert' | 'delete') for that kind, OR be added to the ALLOWED list in this test with a written reason.\n\n${msg}`,
      );
    }
    expect(violations).toEqual([]);
  });

  it('ALLOWED entries still correspond to real files and real writes', () => {
    // Stale allowlist entries hide real bugs. If a file no longer writes to
    // the allowlisted kind, the entry should be removed.
    const stale: string[] = [];
    for (const a of ALLOWED) {
      const full = join(repoRoot, a.file);
      let src: string;
      try {
        src = readFileSync(full, 'utf8');
      } catch {
        stale.push(`${a.file} (kind=${a.kind}): file no longer exists`);
        continue;
      }
      if (a.kind === '*') continue; // wildcard entries don't require a model check
      const model = Object.entries(KIND_BY_MODEL).find(([, k]) => k === a.kind)?.[0];
      if (!model) {
        stale.push(`${a.file} (kind=${a.kind}): unknown kind`);
        continue;
      }
      const writePattern = new RegExp(
        `\\b(?:prisma|tx|[a-zA-Z_$][\\w$]*)\\.${model}\\.(?:${WRITE_METHODS.join('|')})\\b`,
      );
      if (!writePattern.test(src)) {
        stale.push(
          `${a.file} (kind=${a.kind}): no longer writes to ${model}; remove the ALLOWED entry`,
        );
      }
    }
    expect(stale).toEqual([]);
  });
});
