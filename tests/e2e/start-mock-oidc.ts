import { startMockOidc } from './mock-oidc';

// Host-side launcher for the dockerized visual run: starts mock-OIDC on the
// host (the container's Playwright skips globalSetup) and stays alive.
startMockOidc(9999);

// keep the process running until killed
setInterval(() => {}, 1 << 30);
