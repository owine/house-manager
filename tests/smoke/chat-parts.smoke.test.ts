import { describe, expect, it } from 'vitest';

const apiKey = process.env.ANTHROPIC_API_KEY;
const skip = !apiKey || apiKey.includes('placeholder');

// The parts-extraction call is the one model call in the app with NO
// constrained grammar behind it — the two part arms spend 50 optional
// parameters against the API's limit of 24, so `output_config` is not
// available here (see the header of lib/chat/parts-extract.ts).
//
// Output shape therefore rests on two things that only a live call can test:
// the prompt's "single JSON object and no other text" instruction, and
// `extractJsonObject` recovering the document when the model ignores it. This
// used to rest on an assistant prefill instead, which 400s on every model
// after Haiku 4.5.
//
// Run several times: a single pass proves nothing about a probabilistic
// output. The bar is that every attempt yields a parseable object with a
// `proposals` array — not that the model finds the same parts each time.
const ATTEMPTS = 3;

describe.skipIf(skip)('parts extraction live smoke (unconstrained, no prefill)', () => {
  it(`returns parseable JSON with a proposals array on ${ATTEMPTS}/${ATTEMPTS} attempts`, async () => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const { PARTS_EXTRACT_PROMPT, extractJsonObject } = await import('@/lib/chat/parts-extract');
    const { partProposalPayloadSchema } = await import('@/lib/chat/schema');

    const client = new Anthropic({ apiKey });
    const snapshotBlock = [
      'ITEMS',
      '  item-1) Backyard string lights',
      '  item-2) Furnace',
      'SYSTEMS',
      '  (none)',
      'PARTS',
      '  (none)',
    ].join('\n');

    const failures: string[] = [];

    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const res = await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 4096,
        system: [
          { type: 'text', text: PARTS_EXTRACT_PROMPT },
          { type: 'text', text: snapshotBlock },
        ],
        messages: [
          {
            role: 'user',
            content:
              'the backyard string lights take 24 S14 bulbs, E26 base, 2700K, 11 watts each — Feit brand, about $4.50 apiece',
          },
        ],
      });

      const rawText = res.content
        .filter((b): b is typeof b & { type: 'text' } => b.type === 'text')
        .map((b) => b.text)
        .join('');

      // Truncation would masquerade as "the model emitted garbage".
      expect(res.stop_reason, `attempt ${attempt} hit the token ceiling`).not.toBe('max_tokens');

      const extracted = extractJsonObject(rawText);
      if (!extracted) {
        failures.push(`attempt ${attempt}: no JSON object in response: ${rawText.slice(0, 200)}`);
        continue;
      }

      let json: unknown;
      try {
        json = JSON.parse(extracted);
      } catch (e) {
        failures.push(`attempt ${attempt}: unparseable after extraction: ${(e as Error).message}`);
        continue;
      }

      const proposals = (json as { proposals?: unknown }).proposals;
      if (!Array.isArray(proposals)) {
        failures.push(`attempt ${attempt}: no proposals array, got ${JSON.stringify(json)}`);
        continue;
      }

      // Whatever it proposed must survive the same schema the server applies.
      // A shape failure here means the prompt and the schema have drifted.
      for (const p of proposals) {
        const parsed = partProposalPayloadSchema.safeParse(p);
        if (!parsed.success) {
          failures.push(`attempt ${attempt}: proposal rejected: ${parsed.error.message}`);
        }
      }
    }

    expect(failures, failures.join('\n')).toEqual([]);
  }, // only on a good day — give it its own headroom. // Three sequential live calls, comfortably inside the 60s config default
  120_000);
});
