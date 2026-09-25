import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono, Instrument_Serif } from 'next/font/google';
import { browserSentryDsn } from '@/lib/observability/browser-dsn';
import { BROWSER_DSN_META } from '@/lib/observability/sentry-options';
import './globals.css';

// next/font/google downloads the font files at build time and self-hosts
// them, so the runtime doesn't depend on fonts.googleapis.com. Each font
// exposes a CSS variable consumed by the @theme block in globals.css.
const geistSans = Geist({
  subsets: ['latin'],
  variable: '--font-geist-sans',
  display: 'swap',
});
const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
  display: 'swap',
});
const instrumentSerif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  style: ['normal', 'italic'],
  variable: '--font-instrument-serif',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    template: '%s · house manager',
    default: 'house manager',
  },
  description: 'Track home inventory, maintenance, warranties, and reminders.',
  // Private self-hosted app — never want to be indexed if accidentally exposed.
  robots: { index: false, follow: false },
  // Stop iOS Safari from auto-linking serial numbers / model IDs as phone numbers.
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

// Inline script executed synchronously before first paint to apply the stored
// theme. This prevents a flash of the light theme when the user has selected
// dark mode. The script only sets data-theme when the stored value is
// explicitly 'light' or 'dark'; unrecognised or absent values fall through to
// the prefers-color-scheme media query (System mode).
const themeScript = `
  (function() {
    try {
      var t = localStorage.getItem('theme');
      if (t === 'light' || t === 'dark') {
        document.documentElement.setAttribute('data-theme', t);
      }
    } catch (_) {}
  })();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Read per request: every page under (app)/ is dynamic (auth()), so this is
  // the server's runtime env, not the build's. Statically prerendered pages
  // (not-found) are rendered at build time, when it is unset, and so ship no
  // DSN: those pages simply run without browser reporting.
  const sentryDsn = browserSentryDsn();
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${instrumentSerif.variable}`}
    >
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: themeScript is a
            static string literal defined in this file with no user-input interpolation.
            This is the standard React pattern for injecting a pre-paint theme script
            that must run synchronously before hydration to prevent flash-of-wrong-theme. */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        {/* Read by instrumentation-client.ts. A DSN is public by design. */}
        {sentryDsn ? <meta name={BROWSER_DSN_META} content={sentryDsn} /> : null}
      </head>
      <body>{children}</body>
    </html>
  );
}
