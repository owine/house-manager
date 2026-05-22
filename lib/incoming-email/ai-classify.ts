import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { ANTHROPIC_MAX_TOKENS, ANTHROPIC_MODEL, getAnthropic } from '@/lib/ai/client';
import {
  type IncomingEmailClassifyExtract,
  incomingEmailClassifyExtractSchema,
} from '@/lib/ai/schemas';
import type { ClassifyEntity, ClassifyVendor } from '@/lib/incoming-email/classify';
import type { LoadedPdf } from '@/lib/incoming-email/pdf-attachments';

// Cap body input sent to the model. Vendor mail bodies can run long with
// tracking footers / unsubscribe boilerplate; the relevant invoice data is
// almost always in the first 4k characters.
const MAX_BODY_CHARS = 4000;

const SYSTEM_PROMPT =
  `You classify AND extract structured data from inbound emails for a household maintenance app. A single call does both: decide what kind of email this is, which vendor / item / system it concerns, and pull the service details.

CLASSIFICATION
Choose exactly one "kind":
- ESTIMATE: a quote, proposal, or bid for FUTURE work that has not been done yet.
- INVOICE: a bill or receipt for work that has been COMPLETED (amount due, paid in full, payment receipt).
- TICKET: a service report, work order, or visit summary describing work that was performed.
- UNKNOWN: anything that is not a vendor service email (newsletters, marketing, personal mail, account notices).

For vendorId / targetItemId / targetSystemId: choose strictly from the provided candidate ids below, or null. NEVER invent an id — if nothing in the candidate list clearly matches, return null. Pick targetItemId OR targetSystemId, never both; prefer the item (more specific) when either could apply.

For "confidence": return "high" ONLY when the sender, subject, and body together clearly identify both the vendor AND the kind. Use "medium" when one of those is inferred, and "low" when the match is weak or speculative.

EXTRACTION
Goal: extract three fields — cost, date of service, and scope of work — to seed a service record. The user will edit the result before saving, so:
- prefer NULL over a guessed value when a field isn't clearly stated
- pull from explicit phrasing (e.g., "Total Due", "Service Date", "Work Performed"), not inference
- the email's send date is NOT the date of service unless explicitly stated

The email body is provided as text below. PDF attachments (when present) are provided as document content blocks ABOVE the email metadata; their content is authoritative when the body is sparse — many vendors send a generic body like "see attached invoice" with all structured data only in the PDF.

For "cost": the customer's grand total, including tax/fees. Subtotals, "amount due before discount", deposits, and per-line-item prices are NOT the answer.

For "performedOn": ISO date YYYY-MM-DD. The day work was done. NOT the invoice/email date if those differ.

For "scope": a brief, factual paragraph of work performed and findings. Strip pleasantries, signatures, payment links, marketing.

If the email body has no narrative text but DOES have a list of line items (in body OR PDF) like "Replace air filter — $25 / Clean coils — $50 / Service call — $89", synthesize a one-paragraph scope from those line items: combine the action descriptions into a coherent sentence or two, omitting prices and quantities. Drop generic line items like "service call", "trip charge", "tax", "convenience fee" that don't describe work performed.`.trim();

function renderCandidates(label: string, rows: Array<{ id: string; name: string }>): string {
  if (rows.length === 0) return `${label}: (none)`;
  const lines = rows.map((r) => `  ${r.id}) ${r.name}`).join('\n');
  return `${label}:\n${lines}`;
}

function buildUserText(input: {
  fromAddress: string;
  fromName: string | null;
  subject: string;
  bodyText: string;
  emailDate: Date;
  vendors: ClassifyVendor[];
  items: ClassifyEntity[];
  systems: ClassifyEntity[];
}): string {
  const sender = input.fromName ? `${input.fromName} <${input.fromAddress}>` : input.fromAddress;
  return `Email metadata
From: ${sender}
Subject: ${input.subject || '(no subject)'}
Email date: ${input.emailDate.toISOString().slice(0, 10)}

Body (truncated):
"""
${input.bodyText.slice(0, MAX_BODY_CHARS)}
"""

Candidate vendors, items, and systems. Return the id (the value before the ")") or null.
${renderCandidates('Vendors', input.vendors)}
${renderCandidates('Items', input.items)}
${renderCandidates('Systems', input.systems)}

Classify the email (kind / vendorId / targetItemId / targetSystemId / confidence) and extract cost / performedOn / scope.`;
}

export type AiClassifyExtractInput = {
  fromAddress: string;
  fromName: string | null;
  subject: string;
  bodyText: string;
  emailDate: Date;
  vendors: ClassifyVendor[];
  items: ClassifyEntity[];
  systems: ClassifyEntity[];
  pdfs: LoadedPdf[];
};

/**
 * One Anthropic call that classifies an inbound email AND extracts service
 * details from it. Pure of DB writes / logging — the caller (worker job)
 * owns persistence + AI-log. Errors propagate so the caller can fall back
 * to the heuristic classifier.
 */
export async function aiClassifyExtract(
  input: AiClassifyExtractInput,
): Promise<{ result: IncomingEmailClassifyExtract; usage: Record<string, number> }> {
  const userText = buildUserText(input);

  // Documents first (Anthropic recommends documents BEFORE instruction text),
  // then the metadata + body + candidate lists.
  const content: Array<
    | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } }
    | { type: 'text'; text: string }
  > = [];
  for (const pdf of input.pdfs) {
    content.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: pdf.base64 },
    });
  }
  content.push({ type: 'text', text: userText });

  const apiResult = await getAnthropic().messages.parse({
    model: ANTHROPIC_MODEL,
    max_tokens: ANTHROPIC_MAX_TOKENS,
    system: [{ type: 'text', text: SYSTEM_PROMPT }],
    messages: [{ role: 'user', content }],
    output_config: { format: zodOutputFormat(incomingEmailClassifyExtractSchema) },
  } as never);

  const result = (apiResult as { parsed_output: IncomingEmailClassifyExtract }).parsed_output;
  const usage = (apiResult as unknown as { usage?: Record<string, number> }).usage ?? {};
  return { result, usage };
}

/**
 * Re-validate the model-chosen candidate ids against the lists we actually
 * sent. The model can hallucinate ids; any id not present in its candidate
 * list is dropped to null. When both item and system survive, the system is
 * nulled — item wins (more specific, matches promoteToServiceRecord).
 */
export function validateCandidateIds(
  ids: { vendorId: string | null; targetItemId: string | null; targetSystemId: string | null },
  candidates: {
    vendors: Array<{ id: string }>;
    items: Array<{ id: string }>;
    systems: Array<{ id: string }>;
  },
): { vendorId: string | null; targetItemId: string | null; targetSystemId: string | null } {
  const inList = (id: string | null, rows: Array<{ id: string }>) =>
    id !== null && rows.some((r) => r.id === id) ? id : null;

  const vendorId = inList(ids.vendorId, candidates.vendors);
  const targetItemId = inList(ids.targetItemId, candidates.items);
  let targetSystemId = inList(ids.targetSystemId, candidates.systems);
  if (targetItemId && targetSystemId) targetSystemId = null;

  return { vendorId, targetItemId, targetSystemId };
}

/**
 * Confidence floor for auto-stubbing a ServiceRecord from an inbound email:
 * a high-confidence INVOICE or TICKET with a matched vendor AND a matched
 * target (item or system). Anything weaker stays in the triage queue.
 */
export function shouldAutoStub(input: {
  kind: 'ESTIMATE' | 'INVOICE' | 'TICKET' | 'UNKNOWN';
  vendorId: string | null;
  targetItemId: string | null;
  targetSystemId: string | null;
  confidence: 'low' | 'medium' | 'high';
}): boolean {
  return (
    (input.kind === 'TICKET' || input.kind === 'INVOICE') &&
    input.confidence === 'high' &&
    !!input.vendorId &&
    (!!input.targetItemId || !!input.targetSystemId)
  );
}
