/**
 * Shared layout for outbound email. Email clients strip <style> tags and
 * ignore CSS variables / classes — therefore every style here is inline.
 *
 * owine brand tokens are duplicated below as frozen constants. Email and
 * app rendering have irreconcilable CSS capabilities, so the app's
 * CSS-variable token source can't be reused. Keep these in sync manually
 * with the `owine-design` skill if the brand evolves.
 */
import type { ReactNode } from 'react';

// --- owine brand tokens (frozen for email) ---
export const EMAIL_TOKENS = {
  paper: '#f6f4ef',
  card: '#fbfaf6',
  line: '#dcd6cc',
  ink: '#0e1620',
  inkMuted: '#5b6878',
  accent: '#2b5fd9',
  // System font stack — web fonts (Geist) are unreliable in email clients.
  fontStack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
} as const;

const T = EMAIL_TOKENS;

export type LayoutProps = {
  preheader?: string; // hidden preview text shown by some clients
  appUrl: string; // absolute URL base; settings link goes to `${appUrl}/settings`
  children: ReactNode;
};

export function Layout({ preheader, appUrl, children }: LayoutProps): ReactNode {
  return (
    // biome-ignore lint/style/noHeadElement: Email templates require full HTML structure
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>House Manager</title>
      </head>
      <body
        style={{
          margin: 0,
          padding: 0,
          backgroundColor: T.paper,
          color: T.ink,
          fontFamily: T.fontStack,
          fontSize: '16px',
          lineHeight: 1.5,
        }}
      >
        {preheader ? (
          <div
            style={{
              display: 'none',
              maxHeight: 0,
              overflow: 'hidden',
              color: T.paper,
            }}
          >
            {preheader}
          </div>
        ) : null}
        <div
          style={{
            maxWidth: '600px',
            margin: '0 auto',
            padding: '24px 16px',
          }}
        >
          <div
            style={{
              fontSize: '14px',
              fontWeight: 600,
              color: T.ink,
              padding: '0 0 16px 0',
            }}
          >
            House Manager
          </div>
          <div
            style={{
              backgroundColor: T.card,
              border: `1px solid ${T.line}`,
              borderRadius: '8px',
              padding: '24px',
            }}
          >
            {children}
          </div>
          <div
            style={{
              fontSize: '12px',
              color: T.inkMuted,
              padding: '16px 0 0 0',
            }}
          >
            <a
              href={`${appUrl}/settings`}
              style={{ color: T.inkMuted, textDecoration: 'underline' }}
            >
              Manage notification settings
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
