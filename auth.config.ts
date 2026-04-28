import { getEnv } from '@/lib/env';
import type { NextAuthConfig } from 'next-auth';

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
    },
  ],
  callbacks: {
    authorized({ auth }) {
      return !!auth;
    },
  },
} satisfies NextAuthConfig;
