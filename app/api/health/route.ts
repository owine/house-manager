import { APP_GIT_SHA, APP_VERSION } from '@/lib/version';

export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ status: 'ok', version: APP_VERSION, sha: APP_GIT_SHA });
}
