import { httpUrlSchema } from '@/lib/http-url';

/**
 * The browser DSN, read from the SERVER's environment at request time and
 * rendered by app/layout.tsx into `<meta name="sentry-browser-dsn">`, where
 * instrumentation-client.ts picks it up. This is what lets one image serve any
 * deployment: nothing is inlined at build time (a NEXT_PUBLIC_ var would be).
 *
 * Soft-validated: anything but an http(s) URL means "browser reporting off",
 * never a crash. See the note in lib/env.ts for why it isn't in the schema.
 */
export function browserSentryDsn(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const parsed = httpUrlSchema.safeParse(env.SENTRY_BROWSER_DSN);
  return parsed.success ? parsed.data : undefined;
}
