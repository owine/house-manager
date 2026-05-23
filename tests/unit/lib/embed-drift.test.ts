import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Drift guard for the Ask/RAG embedding pipeline — companion to the
 * search-index-drift guard. Every file that writes to an embeddable
 * Prisma model must also enqueue a re-embed for that entity type, or
 * be added to ALLOWED with a reason (e.g. OCR-gated attachment writes
 * where the embed enqueue legitimately happens in the OCR worker).
 */

// Prisma model name → EmbeddingEntityType string used in enqueueEmbed calls.
// Note: vendor + reminder + (system) are intentionally absent — not embedded.
// Checklist embeds under CHECKLIST_ITEM (whole-tree, keyed by checklistId).
const KIND_BY_MODEL: Record<string, string> = {
  item: 'ITEM',
  note: 'NOTE',
  serviceRecord: 'SERVICE_RECORD',
  warranty: 'WARRANTY',
  checklist: 'CHECKLIST_ITEM',
  attachment: 'ATTACHMENT',
};

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

const ALLOWED: { file: string; kind: string; reason: string }[] = [
  {
    file: 'lib/embedding/index.ts',
    kind: '*',
    reason: 'this IS the embedding lib — manages the embedding table directly',
  },
  {
    file: 'lib/attachments/actions.ts',
    kind: 'ATTACHMENT',
    reason:
      'embedding requires extractedText; OCR worker (extract-attachment-text.ts) ' +
      'is the canonical enqueue site once text exists',
  },
  {
    file: 'lib/incoming-email/ingest.ts',
    kind: 'ATTACHMENT',
    reason: 'inbox-received attachments go through the same OCR-gated enqueue path',
  },
  {
    file: 'lib/incoming-email/actions.ts',
    kind: 'ATTACHMENT',
    reason: 'updateMany only sets serviceRecordId; embedded content (extractedText) is unchanged',
  },
  {
    file: 'worker/jobs/thumbnail.ts',
    kind: 'ATTACHMENT',
    reason: 'only writes thumbnailPath; not in the attachment embed content',
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

describe('embed drift guard', () => {
  const repoRoot = process.cwd();
  const roots = ['lib', 'worker'].map((d) => join(repoRoot, d));
  const files = roots.flatMap((r) => walk(r));

  it('every file that writes to an embeddable model also enqueues for that kind', () => {
    const violations: { file: string; kind: string; sample: string }[] = [];

    for (const fullPath of files) {
      const rel = relative(repoRoot, fullPath);
      const src = readFileSync(fullPath, 'utf8');

      for (const [model, kind] of Object.entries(KIND_BY_MODEL)) {
        const writePattern = new RegExp(
          `\\b(?:prisma|tx|[a-zA-Z_$][\\w$]*)\\.${model}\\.(?:${WRITE_METHODS.join('|')})\\b`,
        );
        if (!writePattern.test(src)) continue;
        if (isAllowed(rel, kind)) continue;

        const enqueuePattern = new RegExp(`enqueueEmbed\\(\\s*['"\`]${kind}['"\`]`);
        if (!enqueuePattern.test(src)) {
          const match = src.match(writePattern);
          violations.push({ file: rel, kind, sample: match?.[0] ?? '(unknown)' });
        }
      }
    }

    if (violations.length > 0) {
      const msg = violations
        .map(
          (v) =>
            `  ${v.file}: writes to "${v.kind}" via \`${v.sample}\` but never calls enqueueEmbed('${v.kind}', ...)`,
        )
        .join('\n');
      throw new Error(
        `Embed drift detected. Each file that writes to an embeddable Prisma model must also call enqueueEmbed(<EmbeddingEntityType>, id) for that kind, OR be added to the ALLOWED list in this test with a written reason.\n\n${msg}`,
      );
    }
    expect(violations).toEqual([]);
  });

  it('ALLOWED entries still correspond to real files and real writes', () => {
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
      if (a.kind === '*') continue;
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
