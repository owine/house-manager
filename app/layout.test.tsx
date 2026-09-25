import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

// next/font/google is a compiler transform; outside `next build` it has no
// runtime, so stand in for the three fonts the layout loads.
vi.mock('next/font/google', () => {
  const font = () => ({ variable: 'font-var' });
  return { Geist: font, Geist_Mono: font, Instrument_Serif: font };
});
// Tailwind's PostCSS pipeline doesn't run under Vitest.
vi.mock('./globals.css', () => ({}));

import RootLayout from './layout';

const DSN = 'https://publickey@glitchtip.example/2';

afterEach(() => {
  vi.unstubAllEnvs();
});

// instrumentation-client.ts reads this meta; it is the only way the browser
// learns its DSN, since nothing Sentry-related is inlined at build time.
describe('RootLayout browser DSN meta', () => {
  it('renders the DSN from the server env at request time', () => {
    vi.stubEnv('SENTRY_BROWSER_DSN', DSN);
    const html = renderToStaticMarkup(<RootLayout>{null}</RootLayout>);
    expect(html).toContain(`<meta name="sentry-browser-dsn" content="${DSN}"/>`);
  });

  it('renders no meta when unset or invalid (browser reporting off)', () => {
    vi.stubEnv('SENTRY_BROWSER_DSN', '');
    expect(renderToStaticMarkup(<RootLayout>{null}</RootLayout>)).not.toContain('sentry');
    vi.stubEnv('SENTRY_BROWSER_DSN', 'javascript:alert(1)');
    expect(renderToStaticMarkup(<RootLayout>{null}</RootLayout>)).not.toContain('sentry');
  });
});
