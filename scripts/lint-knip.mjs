#!/usr/bin/env node
// Runs knip, and fails the build when knip reports a *configuration* error.
//
// Why this wrapper exists: knip treats a config-load failure as non-fatal. It
// prints
//
//   ERROR: Error loading prisma.config.ts (Cannot resolve environment variable: DATABASE_URL.)
//   ERROR: Please fix or visit https://knip.dev/reference/known-issues
//
// and then exits 0. So `pnpm lint` stayed green while knip was running with a
// plugin silently switched off — the gate printed the exact error explaining a
// real breakage and still reported success. A gate that cannot fail is not a
// gate.
//
// knip's own non-zero exit (unused files / exports / deps) is passed straight
// through; this only *adds* the missing failure mode.

import { spawn } from 'node:child_process';

const KNIP_BIN = new URL('../node_modules/.bin/knip', import.meta.url).pathname;

// knip writes findings to stdout and these ERROR: lines to stderr. Capture both
// so the check doesn't depend on which stream knip chose, and re-emit each
// chunk as it arrives so output stays streaming rather than buffered to the end.
let combined = '';
const child = spawn(KNIP_BIN, process.argv.slice(2), { stdio: ['inherit', 'pipe', 'pipe'] });

for (const [stream, sink] of [
  [child.stdout, process.stdout],
  [child.stderr, process.stderr],
]) {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    combined += chunk;
    sink.write(chunk);
  });
}

child.on('error', (err) => {
  console.error(`lint:knip — could not run knip: ${err.message}`);
  process.exit(1);
});

child.on('close', (code, signal) => {
  if (signal) {
    console.error(`lint:knip — knip terminated by signal ${signal}`);
    process.exit(1);
  }
  if (code !== 0) process.exit(code ?? 1);

  // Anchored per-line so a filename or an unused export that merely contains
  // the word "ERROR:" can't trip this.
  if (/^ERROR:/m.test(combined)) {
    console.error(
      '\nlint:knip — knip exited 0 but reported a configuration error above.\n' +
        'Knip does not fail on these, so this wrapper does: a plugin that cannot\n' +
        'load is a plugin that is not checking anything. Fix the config error.',
    );
    process.exit(1);
  }
});
