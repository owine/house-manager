#!/usr/bin/env node
// Lints that every `var(--token)` reference in our source has a matching
// definition somewhere — either in `app/globals.css` or as an inline
// `style={{ '--token': … }}` somewhere in the codebase. Catches the
// "silently dropped declaration" class of bug where a typo'd token name
// resolves to empty and the surrounding CSS rule is discarded.
//
// Limitations:
//  - Doesn't try to parse Tailwind class names (e.g. `bg-sidebar` →
//    `var(--color-sidebar)`). Adding that would require resolving the
//    Tailwind config; not worth it. Direct `var(--…)` is the bulk of
//    real-world misses.
//  - Inline definitions are treated as project-global, not scoped. A
//    reference still passes if any component anywhere defines the token.
//    Acceptable trade-off for keeping this a pure regex pass.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SRC_DIRS = ['app', 'components', 'lib', 'hooks'];
const SRC_EXTS = ['.ts', '.tsx', '.css'];

// Tokens that come from upstream stylesheets (Tailwind, tw-animate-css,
// shadcn) and are imported via `@import` in globals.css. We don't have
// their definitions in our tree, so allow-list them.
const EXTERNAL_TOKENS = new Set([
  // Tailwind v4 internals occasionally referenced via var() in shadcn
  // primitives. These are defined by Tailwind's own preflight / @theme.
  'spacing',
  // next/font CSS variables. Defined by `next/font/google` via the
  // `variable` option in app/layout.tsx, applied to <html> as a class.
  // They never appear as a `--token: value` definition in source, so the
  // linter can't see them — allow-list them here.
  'font-geist-sans',
  'font-geist-mono',
  'font-instrument-serif',
]);

const VAR_USE_RE = /var\(\s*(--[a-zA-Z0-9_-]+)/g;
const CSS_DEF_RE = /(^|\s|;|{)(--[a-zA-Z0-9_-]+)\s*:/g;
// Matches both `'--foo':` (object key) and `"--foo":` inline-style defs.
const JSX_STYLE_DEF_RE = /['"](--[a-zA-Z0-9_-]+)['"]\s*:/g;

const defined = new Set(EXTERNAL_TOKENS);
/** @type {Map<string, Array<{file: string, line: number}>>} */
const usages = new Map();

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    const st = statSync(path);
    if (st.isDirectory()) {
      walk(path);
    } else if (SRC_EXTS.some((ext) => entry.endsWith(ext))) {
      scan(path);
    }
  }
}

function scan(file) {
  const raw = readFileSync(file, 'utf8');
  // Strip block comments before regex matching so identifiers inside `/* … */`
  // (e.g. doc strings using `var(--token)` as an example name) aren't picked
  // up as real usages or definitions. We replace each comment with the same
  // number of newlines so the remaining line numbers stay accurate for error
  // messages.
  const text = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  // Definitions
  for (const m of text.matchAll(CSS_DEF_RE)) defined.add(m[2]);
  for (const m of text.matchAll(JSX_STYLE_DEF_RE)) defined.add(m[1]);
  // Usages — capture line numbers for nicer errors
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(VAR_USE_RE)) {
      const token = m[1];
      if (!usages.has(token)) usages.set(token, []);
      usages.get(token).push({ file: relative(ROOT, file), line: i + 1 });
    }
  }
}

for (const dir of SRC_DIRS) {
  try {
    walk(join(ROOT, dir));
  } catch (_e) {
    // Skip dirs that don't exist in this checkout
  }
}

const undefinedTokens = [...usages.entries()]
  .filter(([token]) => !defined.has(token.replace(/^--/, '')) && !defined.has(token))
  .sort(([a], [b]) => a.localeCompare(b));

if (undefinedTokens.length === 0) {
  console.log(`lint:tokens — OK (${usages.size} unique tokens, all defined)`);
  process.exit(0);
}

console.error(`lint:tokens — found ${undefinedTokens.length} undefined CSS custom properties:\n`);
for (const [token, refs] of undefinedTokens) {
  console.error(`  ${token}`);
  for (const { file, line } of refs.slice(0, 5)) {
    console.error(`    ${file}:${line}`);
  }
  if (refs.length > 5) console.error(`    … and ${refs.length - 5} more`);
}
console.error(
  '\nDefine the token in app/globals.css (or as an inline style if it is component-scoped),',
);
console.error('or update the reference to point at an existing token.');
process.exit(1);
