import { execFile } from 'node:child_process';
import type { Server } from 'node:http';
import { promisify } from 'node:util';
import { startMockOidc } from './mock-oidc';

declare global {
  // eslint-disable-next-line no-var
  var __MOCK_OIDC__: Server | undefined;
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
}
