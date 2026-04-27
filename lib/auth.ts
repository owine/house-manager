import { PrismaAdapter } from '@auth/prisma-adapter';
import NextAuth from 'next-auth';

import { authConfig } from '@/auth.config';
import { prisma } from '@/lib/db';
import { getEnv } from '@/lib/env';

const env = getEnv();

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: PrismaAdapter(prisma),
  session: { strategy: 'database' },
  secret: env.AUTH_SECRET,
  events: {
    async createUser({ user }) {
      // The Prisma adapter has just inserted the user row.
      // The OIDC sub is in the Account row created alongside it.
      const account = await prisma.account.findFirst({
        where: { userId: user.id, provider: 'authelia' },
      });
      if (account) {
        await prisma.user.update({
          where: { id: user.id },
          data: { oidcSub: account.providerAccountId },
        });
      }
    },
  },
  callbacks: {
    async signIn({ user, account }) {
      if (account?.provider !== 'authelia') return false;
      if (user.id) {
        await prisma.user
          .update({
            where: { id: user.id },
            data: { lastLoginAt: new Date() },
          })
          .catch(() => {
            // Race during first-ever sign-in: user row may not exist yet. Safe to ignore.
          });
      }
      return true;
    },
    async session({ session, user }) {
      session.user.id = user.id;
      // @ts-expect-error - augmenting session
      session.user.role = (user as { role?: string }).role ?? 'MEMBER';
      return session;
    },
  },
});
