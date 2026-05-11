// AI prompt configuration.
//
// Where things live:
//   - SYSTEM_PROMPT       — instructions sent on every Anthropic call
//   - buildHouseProfileBlock — house profile context (location is coarsened)
//   - buildInventoryBlock — inventory context (no PII fields like serial number)
//   - lib/ai/context-builder.ts — what data is fetched from the DB into the prompt
//
// Data scrubbing:
//   - coarsenLocation strips street-level detail so AI receives at most city/region.
//   - FocusedItem deliberately excludes serialNumber and metadata — never select them here.

export const SYSTEM_PROMPT_VERSION = 'v1';

export const SYSTEM_PROMPT = `You are a household maintenance assistant.
Suggest evidence-based maintenance tasks. Be specific about what the user owns.
Always include a one-sentence rationale.

Privacy rules:
- Do not invent items not in the inventory.
- When suggesting reminders for a specific item, ground the rationale in that item's manufacturer/model when known.

Schema version: ${SYSTEM_PROMPT_VERSION}.`;

// Plan 4c — Ask / RAG system prompt. Deliberately strict: answer only
// from retrieved context, refuse-gracefully when context is insufficient,
// cite every factual claim. The output schema constrains the JSON shape;
// the prompt nudges toward useful behaviour within it.
export const ASK_SYSTEM_PROMPT = `You are an assistant that answers questions about a user's home and household records.

You will be given:
  1. A user question.
  2. A list of retrieved context chunks, each tagged with an entityType and entityId.

Rules:
  - Answer ONLY from the provided context. Do NOT use external knowledge.
  - If the context does not contain enough information to answer, say so clearly. Suggest what record the user might add to help, but do not invent facts.
  - For every factual claim in your answer, include a citation referencing the supporting chunk's entityType and entityId.
  - Keep answers concise and skimmable. Use markdown when it improves readability (bullet lists for multi-item answers, bold for key values).
  - Never speculate about dates, costs, or specifications. Quote them directly from context or omit them.
  - Privacy: do not echo serial numbers, exact addresses, or other PII even if they appear in context.

Schema version: ${SYSTEM_PROMPT_VERSION}.`;

export type Season = 'spring' | 'summer' | 'fall' | 'winter';

export function seasonForDate(d: Date): Season {
  const m = d.getUTCMonth(); // 0 = Jan
  if (m >= 2 && m <= 4) return 'spring'; // Mar, Apr, May
  if (m >= 5 && m <= 7) return 'summer'; // Jun, Jul, Aug
  if (m >= 8 && m <= 10) return 'fall'; // Sep, Oct, Nov
  return 'winter'; // Dec, Jan, Feb
}

/**
 * Coarsen a freeform location string to city/region level.
 * Removes street addresses, ZIP codes, apartment markers, and common street suffixes.
 * Returns null if the input is null, empty, or contains only street-level details.
 */
export function coarsenLocation(input: string | null): string | null {
  if (!input || input.trim() === '') {
    return null;
  }

  const segments = input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const filtered = segments
    .map((segment) => {
      // Strip trailing ZIP codes (e.g., "TX 78701" → "TX", "Austin, TX 78701-1234" → "Austin, TX")
      const withoutZip = segment
        .replace(/\s+\d{5}(-\d{4})?$/, '') // ZIP or ZIP+4 at end
        .trim();

      return withoutZip;
    })
    .filter((segment) => {
      if (!segment) {
        return false;
      }

      // Drop segments starting with a house number followed by a space.
      // \S* after the digits catches "123B Elm St" (alpha suffix) and
      // "12-14 Main St" (hyphenated range) — both still encode street-level detail.
      if (/^\d+\S*\s/.test(segment)) {
        return false;
      }

      // Drop segments containing apartment/unit markers followed by digits
      if (/\b(Apt|Unit|Suite|Ste)\s*\d/i.test(segment)) {
        return false;
      }

      // Drop segments starting with # followed by digit
      if (/^#\d/.test(segment)) {
        return false;
      }

      // Drop segments starting with "PO Box" — also matches "P.O. Box" and "P O Box".
      if (/^P\.?\s*O\.?\s+Box\b/i.test(segment)) {
        return false;
      }

      // Drop segments that are entirely digits (ZIP codes that weren't caught by stripping)
      if (/^\d+$/.test(segment)) {
        return false;
      }

      return true;
    });

  if (filtered.length === 0) {
    return null;
  }

  return filtered.join(', ');
}

export type HouseProfileForPrompt = {
  location: string | null;
  climateZone: string | null;
  propertyType: string | null;
} | null;

export function buildHouseProfileBlock(input: {
  profile: HouseProfileForPrompt;
  today: Date;
}): string {
  const dateStr = input.today.toISOString().slice(0, 10);
  const season = seasonForDate(input.today);
  if (!input.profile) {
    return `House profile: not configured.\nToday: ${dateStr}\nSeason: ${season}`;
  }
  const fmt = (v: string | null) => v ?? 'not specified';
  return [
    'House profile',
    `  Location: ${fmt(coarsenLocation(input.profile.location))}`,
    `  Climate zone: ${fmt(input.profile.climateZone)}`,
    `  Property type: ${fmt(input.profile.propertyType)}`,
    `Today: ${dateStr}`,
    `Season: ${season}`,
  ].join('\n');
}

export type InventoryEntry = {
  id: string;
  name: string;
  categoryName: string;
  location: string | null;
  manufacturer: string | null;
  model: string | null;
};

export function formatInventoryLine(e: InventoryEntry): string {
  const mm = [e.manufacturer, e.model].filter(Boolean).join(' ') || '—';
  return `- id=${e.id} | "${e.name}" | ${e.categoryName} | ${e.location ?? '—'} | ${mm}`;
}

export function buildInventoryBlock(entries: InventoryEntry[]): string {
  if (entries.length === 0) {
    return 'Inventory: no items match the suggestion filter.';
  }
  return [`Inventory (${entries.length} items)`, ...entries.map(formatInventoryLine)].join('\n');
}

export type SystemBlock = {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
};

export function buildSystemBlocks(input: {
  profile: HouseProfileForPrompt;
  today: Date;
  inventory: InventoryEntry[];
}): SystemBlock[] {
  return [
    { type: 'text', text: SYSTEM_PROMPT },
    { type: 'text', text: buildHouseProfileBlock({ profile: input.profile, today: input.today }) },
    {
      type: 'text',
      text: buildInventoryBlock(input.inventory),
      cache_control: { type: 'ephemeral' },
    },
  ];
}
