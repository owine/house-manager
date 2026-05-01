import { auth } from '@/lib/auth';
import { getEnv } from '@/lib/env';

export async function GET() {
  const session = await auth();
  if (!session?.user) return new Response('Unauthorized', { status: 401 });
  const env = getEnv();
  return Response.json({ publicKey: env.WEB_PUSH_VAPID_PUBLIC_KEY });
}
