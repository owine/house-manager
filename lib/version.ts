import pkg from '../package.json' with { type: 'json' };

export const APP_VERSION: string = pkg.version;

// NEXT_PUBLIC_GIT_SHA is set as a Docker build-arg (see Dockerfile + ci.yml).
// Local `pnpm dev` leaves it unset, so the displayed value is 'dev'.
export const APP_GIT_SHA: string = (process.env.NEXT_PUBLIC_GIT_SHA ?? 'dev').slice(0, 7);
