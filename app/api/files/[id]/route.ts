import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { getAttachment } from '@/lib/attachments/queries';
import { fileResponseHeaders } from '@/lib/attachments/serve';
import { openReadStream, resolveStoragePath } from '@/lib/attachments/storage';
import { auth } from '@/lib/auth';
import { getEnv } from '@/lib/env';

type Params = Promise<{ id: string }>;

export async function GET(req: Request, { params }: { params: Params }) {
  const session = await auth();
  if (!session?.user) return new Response('Unauthorized', { status: 401 });

  const { id } = await params;
  const row = await getAttachment(id);
  if (!row) return new Response('Not found', { status: 404 });

  const url = new URL(req.url);
  const wantThumb = url.searchParams.get('thumb') === '1';
  const relPath = wantThumb ? row.thumbnailPath : row.storagePath;
  if (!relPath) return new Response('Not found', { status: 404 });

  const env = getEnv();
  let absPath: string;
  try {
    absPath = resolveStoragePath(env.FILES_DIR, relPath);
  } catch {
    return new Response('Bad path', { status: 500 });
  }

  let size: number;
  try {
    const s = await stat(absPath);
    size = s.size;
  } catch {
    return new Response('Not found', { status: 404 });
  }

  const stream = openReadStream(absPath);
  const body = Readable.toWeb(stream) as ReadableStream;
  // Every security-relevant header comes from one audited place. The stored
  // mimeType is sender-controlled for inbound email, so it is only a hint.
  const headers = fileResponseHeaders({
    mimeType: row.mimeType,
    filename: row.filename,
    isThumbnail: wantThumb,
    size,
  });

  return new Response(body, { status: 200, headers });
}
