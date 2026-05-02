export default async function globalTeardown() {
  const worker = globalThis.__WORKER_PROC__;
  if (worker && !worker.killed) {
    worker.kill('SIGTERM');
  }

  const server = globalThis.__MOCK_OIDC__;
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}
