import { getEnv } from '@/lib/env';
import { getLogger } from '@/lib/logger';

const log = getLogger('embedding.voyage');

const VOYAGE_ENDPOINT = 'https://api.voyageai.com/v1/embeddings';
const VOYAGE_MODEL = 'voyage-3.5-lite';
export const VOYAGE_DIMENSIONS = 1024;
export const VOYAGE_MAX_BATCH = 128;

export type EmbedOptions = {
  /** `query` for retrieval-time embedding (user question), `document` for indexing. */
  inputType?: 'query' | 'document';
};

/** Thrown for transient errors (5xx, 429, network, timeout) — caller can retry. */
export class VoyageRetryableError extends Error {
  constructor(
    message: string,
    public status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'VoyageRetryableError';
  }
}

/** Thrown for permanent errors (4xx other than 429) — do not retry. */
export class VoyageFatalError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = 'VoyageFatalError';
  }
}

type VoyageResponse = {
  data: Array<{ embedding: number[]; index: number }>;
  usage?: { total_tokens?: number };
};

// Inline 429-retry policy. The free tier is 3 RPM / 10K TPM; a backfill
// burst of 20 embeds blows past that, so we soak up the rate-limit with
// in-process sleeps before surfacing the failure to pg-boss. Five
// attempts × ~25s sleep covers the worst-case 2-minute Voyage cool-off.
const MAX_429_RETRIES = 5;
const DEFAULT_RETRY_SLEEP_MS = 25_000;
const MAX_RETRY_SLEEP_MS = 60_000;

// Per-attempt ceiling on one HTTP request, body read included (the signal stays
// attached to the response stream). Voyage answers a 128-input batch in a few
// seconds; 30s means "the connection is wedged", not "the model is slow".
// Without it a half-open socket parks an embed job until pg-boss's 15-minute
// expiry, and parks a chat turn with no bound at all, since chat calls this
// inside the request.
const REQUEST_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(res: Response): number {
  // Honor the `Retry-After` header if Voyage provides one (seconds or HTTP-date).
  const raw = res.headers.get('retry-after');
  if (!raw) return DEFAULT_RETRY_SLEEP_MS;
  const seconds = Number.parseInt(raw, 10);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, MAX_RETRY_SLEEP_MS);
  }
  const date = Date.parse(raw);
  if (Number.isFinite(date)) {
    return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_SLEEP_MS);
  }
  return DEFAULT_RETRY_SLEEP_MS;
}

/**
 * A request that produced no usable response: undici's `TypeError('fetch
 * failed')` (DNS, refused, reset; the errno is on `.cause.code`), our own
 * timeout (a `DOMException` named `TimeoutError`), a body that died mid-read,
 * or a 200 whose body is complete but not valid JSON (`SyntaxError` from
 * `res.json()`). All are treated as transient. The last one is deliberate: a
 * malformed 200 is an upstream glitch, and pg-boss bounds the retries. These used to escape as a bare TypeError, which
 * embed-content treats as permanent, so the job completed and the embedding
 * stayed stale (P-H2). Not retried inline: pg-boss owns the worker's backoff
 * (lib/queue.ts), and a chat turn should fail fast rather than stall.
 */
function transportFailure(err: unknown, attempt: number): VoyageRetryableError {
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  log.warn({ err, attempt }, 'voyage: transport failure');
  return new VoyageRetryableError(`Voyage request failed: ${detail}`, undefined, { cause: err });
}

/**
 * Embed an array of texts via Voyage's REST API. Batches across multiple
 * requests when input length exceeds {@link VOYAGE_MAX_BATCH}. Throws
 * {@link VoyageRetryableError} on 429/5xx/network/timeout so a pg-boss retry
 * will trigger; throws {@link VoyageFatalError} on permanent 4xx so a retry
 * loop doesn't waste tokens on a guaranteed failure.
 *
 * Returns embeddings as `Float32Array[]` in the same order as the input.
 * Each embedding is 1024-dim ({@link VOYAGE_DIMENSIONS}).
 */
export async function embedTexts(
  texts: string[],
  opts: EmbedOptions = {},
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];

  const { VOYAGE_API_KEY } = getEnv();
  if (!VOYAGE_API_KEY) {
    throw new VoyageFatalError('VOYAGE_API_KEY is not configured');
  }

  const inputType = opts.inputType ?? 'document';
  const out = new Array<Float32Array>(texts.length);

  // Batch sequentially. Voyage's free tier is 3 RPM; batching is the
  // throughput lever, not concurrency. 429s within a batch sleep + retry
  // inline so pg-boss doesn't see them.
  for (let start = 0; start < texts.length; start += VOYAGE_MAX_BATCH) {
    const batch = texts.slice(start, start + VOYAGE_MAX_BATCH);
    const json = await postBatch(batch, inputType, VOYAGE_API_KEY);
    for (const row of json.data) {
      // `index` is the position within this batch. Voyage's docs guarantee
      // it but we don't trust it blindly — defensively check bounds.
      if (row.index < 0 || row.index >= batch.length) continue;
      out[start + row.index] = new Float32Array(row.embedding);
    }
  }

  return out;
}

async function postBatch(
  batch: string[],
  inputType: 'query' | 'document',
  apiKey: string,
): Promise<VoyageResponse> {
  let attempt = 0;
  while (true) {
    const res = await fetch(VOYAGE_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        input: batch,
        model: VOYAGE_MODEL,
        input_type: inputType,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch((err: unknown): never => {
      throw transportFailure(err, attempt);
    });

    if (res.ok) {
      return (await res.json().catch((err: unknown): never => {
        throw transportFailure(err, attempt);
      })) as VoyageResponse;
    }

    const body = await res.text().catch(() => '');

    if (res.status === 429 && attempt < MAX_429_RETRIES) {
      const waitMs = retryAfterMs(res);
      attempt += 1;
      log.warn(
        { status: 429, attempt, maxAttempts: MAX_429_RETRIES, waitMs },
        'voyage: 429 — sleeping then retrying inline',
      );
      await sleep(waitMs);
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      log.warn({ status: res.status, body, attempt }, 'voyage: retryable failure');
      throw new VoyageRetryableError(
        `Voyage returned ${res.status} after ${attempt} retries: ${body.slice(0, 200)}`,
        res.status,
      );
    }

    log.error({ status: res.status, body }, 'voyage: fatal failure');
    throw new VoyageFatalError(`Voyage returned ${res.status}: ${body.slice(0, 200)}`, res.status);
  }
}
