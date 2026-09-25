import pkg from '../package.json' with { type: 'json' };

export const APP_VERSION: string = pkg.version;

// Re-exported so existing importers keep one version module. New client-side
// code imports lib/git-sha.ts directly (see the note there).
export { APP_GIT_SHA } from './git-sha';
