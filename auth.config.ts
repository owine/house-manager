import type { NextAuthConfig } from 'next-auth';
import { getEnv } from '@/lib/env';

const env = getEnv();

// Edge-compatible auth config — no Prisma/Node.js-only imports.
// Currently used only by lib/auth.ts (which adds the Prisma adapter and
// callbacks). Kept separate so middleware.ts can be re-added in the future
// without re-extracting the provider config.
export const authConfig = {
  secret: env.AUTH_SECRET,
  trustHost: true,
  providers: [
    {
      id: 'authelia',
      name: 'Authelia',
      type: 'oidc',
      issuer: env.AUTH_OIDC_ISSUER,
      clientId: env.AUTH_OIDC_CLIENT_ID,
      clientSecret: env.AUTH_OIDC_CLIENT_SECRET,
      authorization: { params: { scope: 'openid profile email groups' } },
      // Authelia (4.38+) rejects auth requests without a `state` parameter of
      // sufficient entropy (`invalid_state`). Auth.js v5's default checks for
      // inline OIDC providers omit state, so opt in explicitly.
      checks: ['pkce', 'state'],
      // Auth.js's default sign-in page derives the provider logo from
      // https://authjs.dev/img/providers/<id>.svg, which 404s for non-built-in
      // providers like Authelia. Point at the bundled asset in /public.
      style: { logo: '/authelia.svg' },
    },
  ],
  callbacks: {
    authorized({ auth }) {
      return !!auth;
    },
  },
} satisfies NextAuthConfig;
