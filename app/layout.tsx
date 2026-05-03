import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: {
    template: '%s · House Manager',
    default: 'House Manager',
  },
  description: 'Track home inventory, maintenance, warranties, and reminders.',
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
  return (
    <html lang="en">
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: themeScript is a
            static string literal defined in this file with no user-input interpolation.
            This is the standard React pattern for injecting a pre-paint theme script
            that must run synchronously before hydration to prevent flash-of-wrong-theme. */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
