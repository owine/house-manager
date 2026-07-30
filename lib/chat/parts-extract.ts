import { ANTHROPIC_CHAT_MAX_TOKENS, ANTHROPIC_MODEL, getAnthropic } from '@/lib/ai/client';
import { createSuggestionLog } from '@/lib/ai/log';
import { classifyAnthropicError } from '@/lib/ai/suggest/_shared';
import { getLogger } from '@/lib/logger';
import { buildPartSpecTable } from './prompt';
import { type Snapshot, validateProposal } from './resolve';
import { type PartProposalPayload, partProposalPayloadSchema, stripNullish } from './schema';

const logger = getLogger('chat.parts-extract');

// ─────────────────────────────────────────────────────────────────────────────
// Why parts get their own model call
//
// The main chat call constrains the model with a compiled grammar
// (`zodOutputFormat(chatTurnOutputSchema)`). Three ceilings apply to that
// grammar and to nothing else — ≤24 optional parameters, a compiled-size cap,
// and ~49 union-typed parameters — and the existing six proposal arms are at
// the edge of all three. A seventh and eighth arm 400s every chat turn. See
// `GRAMMAR_ARMS` in ./schema.ts.
//
// This call sends NO `output_config`, so none of the three apply: the model
// writes plain JSON and the server validates it. The cost is that the output
// is no longer guaranteed well-formed, which is why every parse here is
// defensive and every failure returns zero proposals rather than throwing.
// Conversational capture already treats an unusable payload as a non-event —
// `parseStoredPayload` returns null and the proposal goes INVALID — so this
// matches the posture the pipeline already has.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Forcing JSON without a grammar: prefill the assistant turn with an opening
 * brace so the model's first token continues an object rather than starting a
 * sentence, then glue the brace back on before parsing. Measured 3/3 correct
 * with this; without it the model prefixes prose often enough to matter.
 */
const JSON_PREFILL = '{';

function buildSystemPrompt(): string {
  return `You extract PARTS from what the user just said about their house.

A PART is a consumable or replaceable component the user re-buys — a bulb, an
air or water filter, a battery, a belt, a fuse, softener salt. The thing that
consumes it (the light fixture, the furnace) is an ITEM and is NOT your job:
another pass handles items, notes and service records for this same turn.

Return NOTHING — an empty "proposals" array — unless the user actually
described a consumable. That is the common case. Never invent one to be useful.

OUTPUT
Reply with a single JSON object and no other text, no markdown fence:

{"proposals": [ ... ]}

Each proposal is one of two shapes. Every user-supplied or inferred field is
wrapped as {"value": ..., "source": "user" | "inferred"} — "user" for what they
actually said, "inferred" for anything you filled in from your own knowledge
(decoding a model number, for instance). Never present an inference as
something the user told you.

CREATE_PART — a consumable they have not recorded before:

{"kind": "CREATE_PART",
 "name": {"value": "S14 string light bulbs", "source": "user"},
 "partKind": {"value": "BULB", "source": "inferred"},
 "manufacturer": {"value": "Feit", "source": "user"},
 "model": {"value": "S14/LED", "source": "user"},
 "location": {"value": "Backyard", "source": "user"},
 "notes": {"value": "24 on the run", "source": "user"},
 "typicalCost": {"value": "4.50", "source": "user"},
 "spec": {"value": {"base": "E26", "shape": "S14", "watts": 11, "colorTempK": 2700},
          "source": "user"},
 "itemId": "item_abc"}

UPDATE_PART — a correction or addition to a part already in the snapshot:

{"kind": "UPDATE_PART",
 "partId": "part_xyz",
 "spec": {"value": {"merv": 11}, "source": "user"}}

RULES

1. IDs. The snapshot below lists every part, item and system you may reference.
   Use "partId" only from PARTS, and "itemId"/"systemId" only from ITEMS and
   SYSTEMS. NEVER invent an id. A proposal carrying an id that is not in the
   snapshot is discarded server-side.

2. Parent link. On CREATE_PART give "itemId" OR "systemId" — never both —
   naming the thing the part goes into, when the snapshot has it. Omit both if
   it has no parent; "we keep AAAs in the drawer" is a legitimate loose part.

3. partKind is one of: BULB, AIR_FILTER, WATER_FILTER, BATTERY, BELT, FUSE,
   CHEMICAL, OTHER.

4. Specs go in "spec", as typed fields — never as prose in "notes". This is the
   whole point of this pass. Each kind has its own fields; enum-valued fields
   list their allowed options and you must use one of them exactly or leave the
   field out:

${buildPartSpecTable()}

   Every spec field is optional. Omit what the user did not say rather than
   guessing. Numbers are numbers, not strings: 11, not "11W".

5. typicalCost is a plain decimal string — "4.50", never "$4.50" or "about 4.50".

6. Do not propose the same part twice, and do not propose a CREATE_PART for
   something already in the PARTS snapshot — update it instead.`;
}

/** Exported for the prompt-content tests; not used outside this module. */
export const PARTS_EXTRACT_PROMPT = buildSystemPrompt();

/**
 * Reassemble the full JSON document from a prefilled assistant turn.
 *
 * We seed the assistant turn with `{` so the model emits JSON and not prose.
 * Normally it continues *after* that brace, so the document is
 * `JSON_PREFILL + body`. But that is a convention, not a guarantee: a model
 * that echoes its own `{` would yield `{{`, which fails `JSON.parse` and costs
 * the turn its part proposals — silently, because extraction failure degrades
 * to "no proposals" by design.
 */
export function assemblePrefilledJson(body: string): string {
  const trimmed = body.trimStart();
  return trimmed.startsWith(JSON_PREFILL) ? trimmed : JSON_PREFILL + trimmed;
}

/** Concatenate the text blocks of a non-streaming Messages response. */
function responseText(res: unknown): string {
  const content = (res as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

/**
 * Second, unconstrained model call for one chat turn: extract part proposals.
 *
 * **Never throws and never rejects.** A failed extraction degrades to zero part
 * proposals — the main call's proposals still stand and the turn still
 * persists. `chatTurn` relies on that: it starts this promise alongside the
 * main request and awaits it without a guard of its own.
 */
export async function extractPartProposals(args: {
  userId: string;
  turnText: string;
  priorMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  snapshotBlock: string;
  snapshot: Snapshot;
}): Promise<PartProposalPayload[]> {
  // Belt and braces around the whole body, including the logging writes: the
  // contract this function offers `chatTurn` is that it cannot take the turn
  // down, and an unhandled rejection here would do exactly that.
  try {
    return await runExtraction(args);
  } catch (err) {
    logger.warn({ err, userId: args.userId }, 'parts extraction failed unexpectedly');
    return [];
  }
}

async function runExtraction(args: {
  userId: string;
  turnText: string;
  priorMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  snapshotBlock: string;
  snapshot: Snapshot;
}): Promise<PartProposalPayload[]> {
  const { userId, turnText, priorMessages, snapshotBlock, snapshot } = args;
  const start = Date.now();

  let raw: string;
  let usage: Record<string, number> = {};
  try {
    const res = await getAnthropic().messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: ANTHROPIC_CHAT_MAX_TOKENS,
      system: [
        { type: 'text', text: PARTS_EXTRACT_PROMPT },
        // Same block, same cache_control breakpoint as the main call, so the
        // snapshot is billed as a cache read on whichever request lands second.
        { type: 'text', text: snapshotBlock, cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        ...priorMessages,
        { role: 'user' as const, content: turnText },
        { role: 'assistant' as const, content: JSON_PREFILL },
      ],
    } as never);
    raw = assemblePrefilledJson(responseText(res));
    usage = (res as unknown as { usage?: Record<string, number> }).usage ?? {};
  } catch (e) {
    const errorReason = classifyAnthropicError(e);
    logger.warn(
      { event: 'chat.parts.failed', userId, errorReason },
      'parts extraction call failed',
    );
    await createSuggestionLog({
      userId,
      kind: 'chat-parts',
      userPrompt: turnText,
      inventorySnapshotIds: [],
      response: null,
      errorReason,
      model: ANTHROPIC_MODEL,
      latencyMs: Date.now() - start,
    });
    return [];
  }

  await createSuggestionLog({
    userId,
    kind: 'chat-parts',
    userPrompt: turnText,
    inventorySnapshotIds: [],
    response: { partsExtract: raw },
    model: ANTHROPIC_MODEL,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheCreationTokens: usage.cache_creation_input_tokens,
    latencyMs: Date.now() - start,
  });

  return await parsePartProposals(raw, snapshot);
}

/**
 * Exported for tests: everything after the network call. Unconstrained output
 * means the two failure modes below are real rather than theoretical, and both
 * degrade to an empty array.
 */
export async function parsePartProposals(
  raw: string,
  snapshot: Snapshot,
): Promise<PartProposalPayload[]> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    logger.warn({ event: 'chat.parts.dropped', reason: 'unparseable_json' }, 'dropped extraction');
    return [];
  }

  const list = (json as { proposals?: unknown })?.proposals;
  if (!Array.isArray(list)) {
    logger.warn(
      { event: 'chat.parts.dropped', reason: 'no_proposals_array' },
      'dropped extraction',
    );
    return [];
  }

  const out: PartProposalPayload[] = [];
  for (const candidate of list) {
    // Per-proposal, not per-array: one malformed entry must not cost the user
    // the good ones alongside it.
    const parsed = partProposalPayloadSchema.safeParse(candidate);
    if (!parsed.success) {
      logger.info({ event: 'chat.parts.dropped', reason: 'invalid_shape' }, 'dropped proposal');
      continue;
    }
    const p = parsed.data;
    if (p.spec) p.spec.value = stripNullish(p.spec.value) as typeof p.spec.value;

    // The same validator the main call's proposals run through: ids re-checked
    // against the snapshot, spec re-checked against the part kind's schema. An
    // unconstrained model is exactly the one that invents a partId.
    const v = await validateProposal(p, snapshot);
    if (!v.ok) {
      logger.info({ event: 'chat.parts.dropped', reason: v.reason }, 'dropped proposal');
      continue;
    }
    out.push(p);
  }
  return out;
}
