import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import { promisify } from 'node:util';
import { DEFAULT_WORKER_HEALTH_PORT } from '@/worker/health-server';
import { startMockOidc } from './mock-oidc';

declare global {
  // eslint-disable-next-line no-var
  var __MOCK_OIDC__: Server | undefined;
  // eslint-disable-next-line no-var
  var __WORKER_PROC__: ChildProcess | undefined;
}

export default async function globalSetup() {
  // Ensure database migrations are deployed
  const execFileAsync = promisify(execFile);
  try {
    await execFileAsync('pnpm', ['db:deploy']);
  } catch (error) {
    console.error('Failed to deploy migrations:', error);
  }

  const { server } = await startMockOidc(9999);
  globalThis.__MOCK_OIDC__ = server;

  // Spawn the pg-boss worker so search.index / search.reindex jobs enqueued
  // by Server Actions are actually consumed during e2e. Without this, the
  // search spec's poll-for-Furnace times out (jobs accumulate but no consumer).
  //
  // Locally: the test runner's process.env doesn't include the full .env
  // (Next.js auto-loads it for the dev server, not for spawned children), so
  // we use `tsx --env-file=.env` to pull values from .env at startup. CI:
  // the job's env block already populates process.env, no .env file exists,
  // so we use the plain worker:dev script and inherit process.env.
  const useEnvFile = existsSync('.env');
  const workerArgs = useEnvFile
    ? ['exec', 'tsx', '--env-file=.env', 'worker/index.ts']
    : ['worker:dev'];
  const worker = spawn('pnpm', workerArgs, {
    // Piped rather than inherited so we can watch for the readiness line
    // below; both streams are written straight through, so worker logs still
    // show up in the Playwright output exactly as before.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  globalThis.__WORKER_PROC__ = worker;

  await waitForWorkerReady(worker);
}

const WORKER_READY_TIMEOUT_MS = 60_000;

/**
 * Resolve once the worker reports its handlers registered, reject if it dies
 * or never gets there.
 *
 * This replaced a flat 2s sleep, which was both racy and — worse — silent. The
 * worker had been dying at startup in CI for months: web and worker both
 * default /api/health to DEFAULT_WORKER_HEALTH_PORT, CI set no
 * WORKER_HEALTH_PORT, so it exited with EADDRINUSE the moment it booted.
 * Nothing checked the child's exit code, and no @critical spec exercises
 * worker-dependent behaviour, so e2e and a11y stayed green while covering less
 * than they claimed.
 *
 * Same principle as resetAuth's truncate guard: a setup step that silently
 * sets nothing up is worse than one that fails.
 */
function waitForWorkerReady(worker: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    // The registration line is long enough to arrive split across chunks, so
    // match against the accumulated output rather than each chunk.
    let seen = '';
    let settled = false;

    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };

    const watch = (chunk: Buffer, sink: NodeJS.WritableStream) => {
      sink.write(chunk);
      seen += chunk.toString();
      // Emitted by worker/index.ts once every boss.work() handler is attached.
      if (/registered .*jobs/.test(seen)) finish(resolve);
    };

    worker.stdout?.on('data', (chunk: Buffer) => watch(chunk, process.stdout));
    worker.stderr?.on('data', (chunk: Buffer) => watch(chunk, process.stderr));

    worker.once('exit', (code, signal) => {
      finish(() =>
        reject(
          new Error(
            `e2e worker exited during startup (code=${code}, signal=${signal}). Jobs would ` +
              'never be consumed. Check the worker output above — if it is EADDRINUSE on port ' +
              `${DEFAULT_WORKER_HEALTH_PORT}, set WORKER_HEALTH_PORT (see .env.example and the ` +
              'e2e/a11y jobs in ci.yml).',
          ),
        ),
      );
    });

    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `e2e worker did not report its handlers registered within ` +
              `${WORKER_READY_TIMEOUT_MS}ms. Jobs would never be consumed. Check the worker ` +
              'output above.',
          ),
        ),
      );
    }, WORKER_READY_TIMEOUT_MS);
  });
}
