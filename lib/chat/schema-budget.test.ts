import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  incomingEmailClassifyExtractSchema,
  proposeChecklistResponseSchema,
  proposeRemindersResponseSchema,
} from '@/lib/ai/schemas';
import { chatTurnOutputSchema, storedProposalPayloadSchema } from './schema';

// ─────────────────────────────────────────────────────────────────────────────
// Constrained-output budget guard
//
// Every schema below is handed to the Anthropic API as a compiled grammar via
// `zodOutputFormat`. The API enforces three ceilings on that grammar, and it
// enforces them NOWHERE ELSE — a schema that busts one typechecks, lints,
// passes every unit and integration test, and then 400s on every single call.
// That is exactly what happened: commit 45b5f94 added two proposal arms, went
// green across 1167 unit + 436 integration tests, and broke chat completely.
//
//   1. ≤24 OPTIONAL parameters       "too many optional parameters (35)… limit: 24"
//   2. compiled GRAMMAR SIZE          "The compiled grammar is too large"
//   3. ~49 UNION-TYPED parameters     "too many parameters with union types (49…)"
//
// They interact: converting `.optional()` to required-and-nullable escapes (1)
// and immediately spends (3), because a nullable IS a union. `$ref` does not
// help with (2) either — the compiler expands refs, so a shared sub-object is
// charged once per use site.
//
// **This guard covers (1) and (3) only.** (2) cannot be measured locally — the
// grammar is compiled server-side and its size is not a function of anything
// visible here. Do not read a green run as "this schema will be accepted"; a
// live smoke call is still the only proof of that.
//
// Measured on main at the time of writing:
//
//   schema                              optional   union-typed
//   chatTurnOutputSchema                      19             3
//   incomingEmailClassifyExtractSchema         0             7
//   proposeRemindersResponseSchema             1             1
//   proposeChecklistResponseSchema             1             1
//
// The thresholds below sit a little above those. If one fails, the fix is to
// shrink the schema — or move the addition to an unconstrained call, the way
// `lib/chat/parts-extract.ts` handles part proposals. **Raising a threshold to
// make a build pass re-creates the outage this file exists to prevent.**
// ─────────────────────────────────────────────────────────────────────────────

type Counts = { optional: number; union: number };

type JsonSchemaNode = {
  type?: unknown;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode | JsonSchemaNode[];
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
  $defs?: Record<string, JsonSchemaNode>;
  definitions?: Record<string, JsonSchemaNode>;
};

/** A property is union-typed when its `type` is a list, or it branches. */
function isUnionTyped(node: JsonSchemaNode): boolean {
  return Array.isArray(node.type) || Array.isArray(node.anyOf) || Array.isArray(node.oneOf);
}

/**
 * Walk every parameter the compiler will see. Refs are expanded server-side, so
 * `$defs` are walked too — a definition used three times is charged three
 * times against the real limits, which makes this count conservative rather
 * than optimistic.
 */
function countParameters(
  node: JsonSchemaNode | undefined,
  acc: Counts = { optional: 0, union: 0 },
) {
  if (!node || typeof node !== 'object') return acc;

  if (node.properties) {
    const required = new Set(node.required ?? []);
    for (const [name, child] of Object.entries(node.properties)) {
      if (!required.has(name)) acc.optional += 1;
      if (isUnionTyped(child)) acc.union += 1;
      countParameters(child, acc);
    }
  }

  for (const branch of [node.anyOf, node.oneOf, node.allOf]) {
    for (const child of branch ?? []) countParameters(child, acc);
  }
  if (Array.isArray(node.items)) {
    for (const child of node.items) countParameters(child, acc);
  } else {
    countParameters(node.items, acc);
  }
  for (const group of [node.$defs, node.definitions]) {
    for (const child of Object.values(group ?? {})) countParameters(child, acc);
  }

  return acc;
}

function budgetOf(schema: z.ZodType): Counts {
  const format = zodOutputFormat(schema) as unknown as { schema: JsonSchemaNode };
  return countParameters(format.schema);
}

// Thresholds. `optional` is capped below the API's hard 24 in every case; the
// union caps are per-schema headroom over today's measurement, well under the
// ~49 the API allows, because the point is to notice growth early rather than
// to discover it at the ceiling.
const BUDGETS: Array<{ name: string; schema: z.ZodType; optional: number; union: number }> = [
  // 19 / 3 today. The optional headroom here is the tightest in the repo —
  // the six proposal arms nearly fill the API's 24 on their own, which is why
  // part proposals are extracted by a second, unconstrained call instead of
  // becoming a seventh and eighth arm.
  { name: 'chatTurnOutputSchema', schema: chatTurnOutputSchema, optional: 22, union: 8 },
  // 0 / 7 today: every extraction field is required-and-nullable, which is the
  // trade that spends union budget instead of optional budget.
  {
    name: 'incomingEmailClassifyExtractSchema',
    schema: incomingEmailClassifyExtractSchema,
    optional: 6,
    union: 14,
  },
  // 1 / 1 today.
  {
    name: 'proposeRemindersResponseSchema',
    schema: proposeRemindersResponseSchema,
    optional: 6,
    union: 6,
  },
  // 1 / 1 today.
  {
    name: 'proposeChecklistResponseSchema',
    schema: proposeChecklistResponseSchema,
    optional: 6,
    union: 6,
  },
];

describe('constrained-output schema budgets', () => {
  it.each(BUDGETS)('$name stays under its parameter budget', ({ schema, optional, union }) => {
    const counts = budgetOf(schema);
    expect(counts.optional).toBeLessThan(optional);
    expect(counts.union).toBeLessThan(union);
    // The API's own hard limit, restated so a future threshold edit cannot
    // quietly walk past it.
    expect(counts.optional).toBeLessThan(24);
  });

  it('rejects the eight-arm union that broke chat in 45b5f94', () => {
    // The exact schema that shipped and 400d: the part arms folded into the
    // grammar instead of extracted separately. 69 optional parameters against
    // a hard limit of 24 — this is the regression the guard is for.
    const eightArm = z.object({
      reply: z.string(),
      proposals: z.array(storedProposalPayloadSchema).default([]),
    });
    expect(budgetOf(eightArm).optional).toBeGreaterThan(24);
  });

  it('counts an added optional field — the guard is not vacuous', () => {
    const before = budgetOf(chatTurnOutputSchema);
    const after = budgetOf(
      chatTurnOutputSchema.extend({ extra: chatTurnOutputSchema.shape.reply }),
    );
    expect(after.optional).toBe(before.optional);

    const withOptional = budgetOf(
      chatTurnOutputSchema.extend({ extra: chatTurnOutputSchema.shape.reply.optional() }),
    );
    expect(withOptional.optional).toBe(before.optional + 1);
  });
});
