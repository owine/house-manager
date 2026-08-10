import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import { promisify } from 'node:util';
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
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
  });
  globalThis.__WORKER_PROC__ = worker;

  // Fail loudly if the worker dies at startup instead of letting the whole
  // suite run with no job consumer. It did exactly that in CI for months:
  // web and worker both default /api/health to port 3000, CI set no
  // WORKER_HEALTH_PORT, so the worker exited with EADDRINUSE the moment it
  // booted. Nothing checked this child's exit code, and the @critical subset
  // happens not to exercise any worker-dependent behaviour, so e2e and a11y
  // stayed green while silently covering less than they claimed.
  //
  // Same principle as resetAuth's truncate guard: a setup step that silently
  // sets nothing up is worse than one that fails.
  let workerExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  worker.once('exit', (code, signal) => {
    workerExit = { code, signal };
  });

  // Give the worker a beat to register handlers before tests start enqueueing.
  await new Promise((resolve) => setTimeout(resolve, 2_000));

  if (workerExit) {
    throw new Error(
      `e2e worker exited during startup (code=${workerExit.code}, signal=${workerExit.signal}). ` +
        'Jobs would never be consumed. Check the worker output above — if it is EADDRINUSE on ' +
        'port 3000, set WORKER_HEALTH_PORT (see .env.example and the e2e/a11y jobs in ci.yml).',
    );
  }
}
