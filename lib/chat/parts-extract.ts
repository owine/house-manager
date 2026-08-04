import type { Message, TextBlock, Usage } from '@anthropic-ai/sdk/resources/messages';
import {
  ANTHROPIC_CHAT_MAX_TOKENS,
  ANTHROPIC_CHAT_TIMEOUT_MS,
  ANTHROPIC_MODEL,
  getAnthropic,
} from '@/lib/ai/client';
import { createSuggestionLog, usageLogFields } from '@/lib/ai/log';
import { classifyAnthropicError, classifyStopReason } from '@/lib/ai/suggest/_shared';
import { getLogger } from '@/lib/logger';
import { buildPartSpecTable } from './prompt';
import { type Snapshot, snapshotLogIds, validateProposal } from './resolve';
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
//
// No assistant prefill, either. This call used to seed the assistant turn with
// `{` so the model's first token continued an object rather than starting a
// sentence. That works on Haiku 4.5 and 400s on every model after it — a
// last-assistant-turn prefill is rejected across the 4.6-and-later line (Opus
// 4.6+, Sonnet 4.6+, Opus 5, Sonnet 5, Fable 5). Because extraction failure
// degrades to "no proposals" by design, bumping `ANTHROPIC_MODEL` would have
// turned parts capture off silently rather than loudly. Two things replace it:
// the prompt forbids prose and fences, and `extractJsonObject` tolerates them
// anyway when the model ignores that.
// ─────────────────────────────────────────────────────────────────────────────

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
 * Pull the JSON document out of an unconstrained completion.
 *
 * Takes the outermost `{`…`}` span, which unwraps a markdown fence and strips
 * prose on either side in one step. Returns `''` when there is no object at
 * all, so the caller's `JSON.parse` throws and the turn degrades to zero part
 * proposals — the same designed failure mode as any other unusable payload.
 *
 * **This is load-bearing, not defensive padding.** Haiku 4.5 wraps its answer
 * in a ```json fence on every observed call — 3/3 in the live smoke, across
 * two parts-bearing messages and one that correctly proposes nothing — despite
 * the prompt's "no other text, no markdown fence". The prompt does not win that
 * argument, so something has to unwrap it. That is also why removing the old
 * assistant prefill required this in the same change rather than after it: the
 * prefill was masking the fence, and dropping it while keeping the old
 * brace-prepending assembler would have yielded `{```json{…}```` on every turn
 * — unparseable, zero proposals, no error anywhere.
 *
 * Deliberately not a fence-specific regex: the model has more ways to wrap an
 * object than it has fence syntaxes, and brace-span extraction covers all of
 * them without enumerating any.
 */
export function extractJsonObject(text: string): string {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last <= first) return '';
  return text.slice(first, last + 1);
}

/** Concatenate the text blocks of a non-streaming Messages response. */
function responseText(res: Message): string {
  return res.content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
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
  let usage: Usage | undefined;
  try {
    const res = await getAnthropic().messages.create(
      {
        model: ANTHROPIC_MODEL,
        max_tokens: ANTHROPIC_CHAT_MAX_TOKENS,
        system: [
          { type: 'text', text: PARTS_EXTRACT_PROMPT },
          // This breakpoint does NOT share the main call's cache entry, and cannot:
          // caching is a prefix match, and the block ahead of this one differs
          // (PARTS_EXTRACT_PROMPT here, CHAT_SYSTEM_PROMPT there), so the two
          // calls have different cache keys no matter that the snapshot text is
          // byte-identical. Nor does it currently write an entry of its own —
          // this prefix measures 2.7–3.0k tokens in production against Haiku
          // 4.5's 4096-token minimum, so the marker is inert (verified: six
          // `chat-parts` rows, cacheCreationTokens and cacheReadTokens both 0).
          //
          // Kept because it costs nothing and starts working the moment the
          // prefix clears the minimum — a larger snapshot, or a model with a
          // lower one. Do NOT try to fix it by moving the snapshot ahead of the
          // system prompt to create a shared prefix: the snapshot alone is
          // smaller still, so neither call would cache and the main call's
          // currently-working ~5k entry would be lost.
          { type: 'text', text: snapshotBlock, cache_control: { type: 'ephemeral' } },
        ],
        messages: [...priorMessages, { role: 'user' as const, content: turnText }],
      },
      // Shares the chat turn's budget: it runs concurrently with the main call
      // and the user is waiting on both.
      { timeout: ANTHROPIC_CHAT_TIMEOUT_MS },
    );
    usage = res.usage;
    // A truncated document is not a model that "emitted garbage" — it is a
    // token ceiling, and it should not be logged as `unparseable_json` and
    // sent to someone to go re-read the prompt. Same for a refusal.
    const stopIssue = classifyStopReason(res.stop_reason);
    if (stopIssue) {
      logger.warn(
        { event: 'chat.parts.dropped', userId, reason: stopIssue, stopReason: res.stop_reason },
        'parts extraction unusable',
      );
      await createSuggestionLog({
        userId,
        kind: 'chat-parts',
        userPrompt: turnText,
        inventorySnapshotIds: snapshotLogIds(snapshot),
        response: null,
        errorReason: stopIssue,
        model: ANTHROPIC_MODEL,
        ...usageLogFields(usage),
        latencyMs: Date.now() - start,
      });
      return [];
    }
    raw = extractJsonObject(responseText(res));
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
      inventorySnapshotIds: snapshotLogIds(snapshot),
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
    inventorySnapshotIds: snapshotLogIds(snapshot),
    response: { partsExtract: raw },
    model: ANTHROPIC_MODEL,
    ...(usage ? usageLogFields(usage) : {}),
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
