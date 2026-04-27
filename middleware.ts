import { authConfig } from '@/auth.config';
import NextAuth from 'next-auth';

const { auth } = NextAuth(authConfig);

export default auth((req) => {
  const isAppRoute = req.nextUrl.pathname.startsWith('/dashboard');
  if (isAppRoute && !req.auth) {
    const url = new URL('/api/auth/signin', req.url);
    return Response.redirect(url);
  }
});

export const config = {
  matcher: ['/dashboard/:path*'],
};
