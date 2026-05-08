import { timingSafeEqual } from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';
import { getEnv } from '@/lib/env';
import { ingestIncomingEmail } from '@/lib/incoming-email/actions';
import { verifyWebhookSignature } from '@/lib/incoming-email/hmac';
import { ForwardEmailWebhookSchema } from '@/lib/incoming-email/schema';
import { getLogger } from '@/lib/logger';
import { getBoss, Queue } from '@/lib/queue';

export const runtime = 'nodejs'; // node:crypto required
export const dynamic = 'force-dynamic';

const log = getLogger('inbound-email');
const MAX_BODY_BYTES = 25 * 1024 * 1024; // 25 MB

function constantTimeStringEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const env = getEnv();
  const { token } = await params;

  // The inbox feature is opt-in: a deployment that hasn't set both env vars
  // shouldn't accept webhook deliveries at all. 503 (Service Unavailable) is
  // accurate — the resource exists but isn't configured to serve traffic.
  if (!env.INBOUND_EMAIL_TOKEN || !env.INBOUND_EMAIL_HMAC_KEY) {
    log.warn('inbound-email: webhook hit but env not configured');
    return NextResponse.json({ error: 'inbox not configured' }, { status: 503 });
  }

  // 1. Token check (sanity / routing). The token lives in DNS TXT and is not
  //    a secret on its own; HMAC carries the real defense. Mismatch → fast
  //    reject so we don't run HMAC on misrouted requests.
  if (!constantTimeStringEqual(token, env.INBOUND_EMAIL_TOKEN)) {
    log.warn({ ip: req.headers.get('x-forwarded-for') ?? null }, 'inbound-email: token mismatch');
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // 2. Read raw body BEFORE JSON parsing so the HMAC is computed over the
  //    bytes ForwardEmail signed. Re-stringifying after JSON.parse would
  //    produce a byte-different (though semantically equivalent) body.
  const rawBody = await req.text();
  // Buffer.byteLength counts UTF-8 bytes, which matches the wire size and the
  // bytes the HMAC was computed over. rawBody.length would count UTF-16 code
  // units and undercount any payload with non-ASCII characters.
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'payload too large' }, { status: 413 });
  }

  // 3. HMAC check (primary defense). The key never traverses the wire after
  //    initial configuration in ForwardEmail's dashboard.
  const sig = req.headers.get('x-webhook-signature');
  if (!verifyWebhookSignature(rawBody, sig, env.INBOUND_EMAIL_HMAC_KEY)) {
    log.warn(
      { ip: req.headers.get('x-forwarded-for') ?? null, sigPresent: sig !== null },
      'inbound-email: signature mismatch',
    );
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // 4. JSON parse + Zod validate.
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = ForwardEmailWebhookSchema.safeParse(json);
  if (!parsed.success) {
    log.error(
      { issues: parsed.error.issues.slice(0, 5) },
      'inbound-email: schema validation failed',
    );
    return NextResponse.json({ error: 'invalid payload' }, { status: 400 });
  }

  // 5. Persist + enqueue classify job.
  let result: { id: string; duplicate: boolean };
  try {
    result = await ingestIncomingEmail(parsed.data);
  } catch (err) {
    log.error({ err }, 'inbound-email: ingest threw');
    // Returning 500 lets ForwardEmail retry; transient infra blips recover.
    return NextResponse.json({ error: 'internal error' }, { status: 500 });
  }

  if (!result.duplicate) {
    try {
      const boss = await getBoss();
      await boss.send(Queue.ClassifyIncomingEmail, { id: result.id });
    } catch (err) {
      // Ingestion already succeeded; classify-job enqueue failure shouldn't
      // cause a retry of the whole webhook (would create duplicate rows is
      // safe via Message-ID dedup, but unnecessary). Log loudly.
      log.error({ err, id: result.id }, 'inbound-email: classify enqueue failed');
    }
  }

  log.info(
    { id: result.id, duplicate: result.duplicate, messageId: parsed.data.messageId },
    'inbound-email: ingested',
  );
  return NextResponse.json({ id: result.id, duplicate: result.duplicate }, { status: 200 });
}
