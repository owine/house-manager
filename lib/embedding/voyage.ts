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

/** Thrown for transient errors (5xx, 429, network) — caller can retry. */
export class VoyageRetryableError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
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

/**
 * Embed an array of texts via Voyage's REST API. Batches across multiple
 * requests when input length exceeds {@link VOYAGE_MAX_BATCH}. Throws
 * {@link VoyageRetryableError} on 429/5xx/network so a pg-boss retry will
 * trigger; throws {@link VoyageFatalError} on permanent 4xx so a retry
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

  // Batch sequentially. Voyage's free tier is 3 rps; batching is the
  // throughput lever, not concurrency.
  for (let start = 0; start < texts.length; start += VOYAGE_MAX_BATCH) {
    const batch = texts.slice(start, start + VOYAGE_MAX_BATCH);
    const res = await fetch(VOYAGE_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({
        input: batch,
        model: VOYAGE_MODEL,
        input_type: inputType,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 429 || res.status >= 500) {
        log.warn({ status: res.status, body }, 'voyage: retryable failure');
        throw new VoyageRetryableError(
          `Voyage returned ${res.status}: ${body.slice(0, 200)}`,
          res.status,
        );
      }
      log.error({ status: res.status, body }, 'voyage: fatal failure');
      throw new VoyageFatalError(
        `Voyage returned ${res.status}: ${body.slice(0, 200)}`,
        res.status,
      );
    }

    const json = (await res.json()) as VoyageResponse;
    for (const row of json.data) {
      // `index` is the position within this batch. Voyage's docs guarantee
      // it but we don't trust it blindly — defensively check bounds.
      if (row.index < 0 || row.index >= batch.length) continue;
      out[start + row.index] = new Float32Array(row.embedding);
    }
  }

  return out;
}
