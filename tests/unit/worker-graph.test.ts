import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — untyped .mjs; allowJs is false so TS2307 always fires here
const { walkWorkerGraph, packageNameOf } = await import('../../scripts/worker-graph.mjs');

type WalkResult = {
  files: Map<string, { importer: string; specifier: string }>;
  bareSpecifiers: Map<string, string>;
  unresolved: Array<{ importer: string; specifier: string }>;
};

let root: string;

/** Write a fixture file relative to the temp repo root, creating parents. */
function file(relPath: string, contents: string): void {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents, 'utf8');
}

function walk(entrypoints: string[], shouldFollow?: (relPath: string) => boolean): WalkResult {
  return walkWorkerGraph({ root, entrypoints, shouldFollow }) as WalkResult;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'worker-graph-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('packageNameOf', () => {
  it('returns the bare name for an unscoped package', () => {
    expect(packageNameOf('pino')).toBe('pino');
  });

  it('strips subpaths from an unscoped package', () => {
    expect(packageNameOf('date-fns/tz')).toBe('date-fns');
  });

  it('keeps both segments of a scoped package', () => {
    expect(packageNameOf('@prisma/client')).toBe('@prisma/client');
  });

  it('strips subpaths from a scoped package', () => {
    expect(packageNameOf('@scope/pkg/sub')).toBe('@scope/pkg');
    expect(packageNameOf('@sentry/node/esm/deep/path')).toBe('@sentry/node');
  });
});

describe('walkWorkerGraph', () => {
  it('follows relative specifiers transitively and records the importer', () => {
    file('worker/index.ts', "import { a } from './a';");
    file('worker/a.ts', "export { b } from './nested/b';");
    file('worker/nested/b.ts', 'export const b = 1;');

    const { files } = walk(['worker/index.ts']);

    expect([...files.keys()].sort()).toEqual([
      'worker/a.ts',
      'worker/index.ts',
      'worker/nested/b.ts',
    ]);
    expect(files.get('worker/index.ts')).toEqual({ importer: '', specifier: '' });
    expect(files.get('worker/a.ts')).toEqual({ importer: 'worker/index.ts', specifier: './a' });
    expect(files.get('worker/nested/b.ts')).toEqual({
      importer: 'worker/a.ts',
      specifier: './nested/b',
    });
  });

  it('resolves the @/ alias against the repo root', () => {
    file('worker/index.ts', "import { q } from '@/lib/queue';");
    file('lib/queue.ts', 'export const q = 1;');

    const { files, unresolved } = walk(['worker/index.ts']);

    expect(files.has('lib/queue.ts')).toBe(true);
    expect(unresolved).toEqual([]);
  });

  it('resolves directory imports via an index file', () => {
    file('worker/index.ts', "import { x } from '@/lib/thing';");
    file('lib/thing/index.ts', 'export const x = 1;');

    const { files } = walk(['worker/index.ts']);

    expect(files.has('lib/thing/index.ts')).toBe(true);
  });

  it('collects bare specifiers as package names with the first importer', () => {
    file('worker/index.ts', "import pino from 'pino';\nimport { a } from './a';");
    file('worker/a.ts', "import { PrismaClient } from '@prisma/client/edge';");

    const { bareSpecifiers } = walk(['worker/index.ts']);

    expect(bareSpecifiers.get('pino')).toBe('worker/index.ts');
    expect(bareSpecifiers.get('@prisma/client')).toBe('worker/a.ts');
  });

  it('keeps the FIRST importer when a package is imported twice', () => {
    file('worker/index.ts', "import pino from 'pino';\nimport { a } from './a';");
    file('worker/a.ts', "import pino from 'pino';");

    const { bareSpecifiers } = walk(['worker/index.ts']);

    expect(bareSpecifiers.get('pino')).toBe('worker/index.ts');
  });

  it('matches side-effect imports (`import "pkg"`)', () => {
    file('worker/index.ts', "import 'dotenv/config';\nimport './side';");
    file('worker/side.ts', 'export {};');

    const { bareSpecifiers, files } = walk(['worker/index.ts']);

    expect(bareSpecifiers.has('dotenv')).toBe(true);
    expect(files.has('worker/side.ts')).toBe(true);
  });

  it('matches require() and dynamic import() specifiers', () => {
    file('worker/index.ts', "const s = require('sharp');\nconst m = import('@aws-sdk/client-s3');");

    const { bareSpecifiers } = walk(['worker/index.ts']);

    expect([...bareSpecifiers.keys()].sort()).toEqual(['@aws-sdk/client-s3', 'sharp']);
  });

  it('excludes node: builtins from both files and bare specifiers', () => {
    file('worker/index.ts', "import { readFileSync } from 'node:fs';\nimport 'node:http';");

    const { bareSpecifiers, files, unresolved } = walk(['worker/index.ts']);

    expect([...bareSpecifiers.keys()]).toEqual([]);
    expect([...files.keys()]).toEqual(['worker/index.ts']);
    expect(unresolved).toEqual([]);
  });

  it('strips block and line comments so documented imports do not count', () => {
    file(
      'worker/index.ts',
      [
        "// import ghost from 'ghost-line';",
        "/* import ghost from 'ghost-block'; */",
        "/*\n * import { x } from '@/lib/ghost-multiline';\n */",
        "import real from 'real-pkg';",
      ].join('\n'),
    );

    const { bareSpecifiers, unresolved } = walk(['worker/index.ts']);

    expect([...bareSpecifiers.keys()]).toEqual(['real-pkg']);
    expect(unresolved).toEqual([]);
  });

  it('reports specifiers that resolve to nothing on disk', () => {
    file('worker/index.ts', "import { gone } from '@/lib/does-not-exist';");

    const { unresolved, files } = walk(['worker/index.ts']);

    expect(unresolved).toEqual([
      { importer: 'worker/index.ts', specifier: '@/lib/does-not-exist' },
    ]);
    expect(files.has('lib/does-not-exist.ts')).toBe(false);
  });

  it('walks every entrypoint, not just the first', () => {
    file('worker/index.ts', "import { a } from '@/lib/a';");
    file('lib/a.ts', 'export const a = 1;');
    file(
      'prisma/seed.ts',
      "import { b } from '@/lib/b';\nimport { PrismaClient } from '@prisma/client';",
    );
    file('lib/b.ts', 'export const b = 2;');

    const { files, bareSpecifiers } = walk(['worker/index.ts', 'prisma/seed.ts']);

    expect(files.has('prisma/seed.ts')).toBe(true);
    expect(files.has('lib/b.ts')).toBe(true);
    expect(bareSpecifiers.get('@prisma/client')).toBe('prisma/seed.ts');
  });

  it('visits a shared module once even when reached from two entrypoints', () => {
    file('worker/index.ts', "import { s } from '@/lib/shared';");
    file('prisma/seed.ts', "import { s } from '@/lib/shared';");
    file('lib/shared.ts', 'export const s = 1;');

    const { files } = walk(['worker/index.ts', 'prisma/seed.ts']);

    // First writer wins: worker/index.ts is walked first.
    expect(files.get('lib/shared.ts')?.importer).toBe('worker/index.ts');
    expect(files.size).toBe(3);
  });

  describe('shouldFollow', () => {
    it('records a gated file but does not descend into it', () => {
      file('worker/index.ts', "import { k } from '@/components/kind-labels';");
      file('components/kind-labels.ts', "import huge from 'huge-ui-dep';\nexport const k = 1;");

      const { files, bareSpecifiers } = walk(
        ['worker/index.ts'],
        (rel) => !rel.startsWith('components/'),
      );

      // Recorded, so the guard can report it...
      expect(files.get('components/kind-labels.ts')).toEqual({
        importer: 'worker/index.ts',
        specifier: '@/components/kind-labels',
      });
      // ...but its own imports never became roots.
      expect(bareSpecifiers.has('huge-ui-dep')).toBe(false);
    });

    it('descends normally when shouldFollow returns true', () => {
      file('worker/index.ts', "import { a } from '@/lib/a';");
      file('lib/a.ts', "import ok from 'ok-pkg';\nexport const a = 1;");

      const { files, bareSpecifiers } = walk(['worker/index.ts'], () => true);

      expect(files.has('lib/a.ts')).toBe(true);
      expect(bareSpecifiers.has('ok-pkg')).toBe(true);
    });

    it('is not consulted for entrypoints themselves', () => {
      file('worker/index.ts', "import { a } from '@/lib/a';");
      file('lib/a.ts', 'export const a = 1;');

      const { files } = walk(['worker/index.ts'], () => false);

      expect(files.has('worker/index.ts')).toBe(true);
      // lib/a.ts is still recorded, just not descended into.
      expect(files.has('lib/a.ts')).toBe(true);
    });
  });
});
