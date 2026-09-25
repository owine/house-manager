// The short git SHA of this build: the Sentry release, and the footer's
// version stamp. Its own file, apart from lib/version.ts, because the browser
// bundle needs it (instrumentation-client.ts, via sentry-options.ts) and has
// no use for lib/version.ts's package.json import.
//
// Two sources, because the two roles see different env:
//   - NEXT_PUBLIC_GIT_SHA: a build-stage ENV in the Dockerfile. Next inlines it
//     into the web server and browser bundles at `next build`.
//   - GIT_SHA: the runtime-stage ENV. The worker runs source under tsx, so it
//     reads process.env at runtime, where only GIT_SHA exists. Without this
//     fallback every worker event was released as 'dev'.
// Local `pnpm dev` sets neither, so the value is 'dev'. `||`, not `??`: an
// empty-string env var (a build-arg passed but not populated) must also fall
// through to the next source rather than being reported as the release.
export const APP_GIT_SHA: string = (
  process.env.NEXT_PUBLIC_GIT_SHA ||
  process.env.GIT_SHA ||
  'dev'
).slice(0, 7);
