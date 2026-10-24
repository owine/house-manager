// The short git SHA of this build: the Sentry release, the footer's version
// stamp, and /api/health's `sha`. It is the app's only version identity. The
// semver lives in image tags, and release.yml applies it by retagging an
// already-built digest, so nothing inside the image can know which release
// (if any) it became. package.json's `version` is not reported anywhere for
// the same reason. The browser bundle imports this too
// (instrumentation-client.ts, via sentry-options.ts).
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
