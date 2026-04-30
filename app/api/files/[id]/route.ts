import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { getAttachment } from '@/lib/attachments/queries';
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
  const headers = new Headers();
  headers.set('Content-Type', wantThumb ? 'image/webp' : row.mimeType);
  headers.set('Content-Length', String(size));
  // Percent-encode the user-supplied filename to prevent header injection.
  const safeName = encodeURIComponent(row.filename);
  headers.set('Content-Disposition', `inline; filename="${safeName}"`);
  headers.set('Cache-Control', 'private, max-age=300');

  return new Response(body, { status: 200, headers });
}
