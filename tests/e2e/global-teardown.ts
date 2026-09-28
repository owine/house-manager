// The worker's graceful shutdown (boss.stop) finishes in about a second; this
// only bounds a wedged one so teardown can never hang the run.
const WORKER_STOP_TIMEOUT_MS = 15_000;

export default async function globalTeardown() {
  const worker = globalThis.__WORKER_PROC__;
  if (worker && worker.exitCode === null && worker.signalCode === null) {
    // Wait for the exit rather than firing and forgetting: otherwise the
    // worker is still shutting down when Playwright exits, and anything that
    // goes wrong from then on happens to an orphan nobody is watching.
    const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()));
    worker.kill('SIGTERM');
    const timer = setTimeout(() => worker.kill('SIGKILL'), WORKER_STOP_TIMEOUT_MS);
    await exited;
    clearTimeout(timer);
  }

  const server = globalThis.__MOCK_OIDC__;
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}
