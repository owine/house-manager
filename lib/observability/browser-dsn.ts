import { httpUrlSchema } from '@/lib/http-url';

/**
 * The browser DSN, read from the SERVER's environment at request time and
 * rendered by app/layout.tsx into `<meta name="sentry-browser-dsn">`, where
 * instrumentation-client.ts picks it up. This is what lets one image serve any
 * deployment: nothing is inlined at build time (a NEXT_PUBLIC_ var would be).
 *
 * Soft-validated: anything but an http(s) URL means "browser reporting off",
 * never a crash. See the note in lib/env.ts for why it isn't in the schema.
 *
 * A real Sentry/GlitchTip DSN's userinfo is the public key only
 * (`https://<publicKey>@host/<projectId>`) — never a password. This is
 * rendered into a PUBLIC `<meta>` tag, so a DSN that does carry a password
 * (a copy-paste of the wrong URL) is rejected rather than shipped to every
 * visitor's browser.
 */
export function browserSentryDsn(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const parsed = httpUrlSchema.safeParse(env.SENTRY_BROWSER_DSN);
  if (!parsed.success) return undefined;
  try {
    if (new URL(parsed.data).password) return undefined;
  } catch {
    return undefined;
  }
  return parsed.data;
}
