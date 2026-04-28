export default async function globalTeardown() {
  const server = globalThis.__MOCK_OIDC__;
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}
