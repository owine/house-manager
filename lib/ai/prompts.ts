export const SYSTEM_PROMPT_VERSION = 'v1';

export const SYSTEM_PROMPT = `You are a household maintenance assistant.
Suggest evidence-based maintenance tasks. Be specific about what the user owns.
Always include a one-sentence rationale.

Privacy rules:
- Do not invent items not in the inventory.
- When suggesting reminders for a specific item, ground the rationale in that item's manufacturer/model when known.

Schema version: ${SYSTEM_PROMPT_VERSION}.`;

export type Season = 'spring' | 'summer' | 'fall' | 'winter';

export function seasonForDate(d: Date): Season {
  const m = d.getUTCMonth(); // 0 = Jan
  if (m >= 2 && m <= 4) return 'spring'; // Mar, Apr, May
  if (m >= 5 && m <= 7) return 'summer'; // Jun, Jul, Aug
  if (m >= 8 && m <= 10) return 'fall'; // Sep, Oct, Nov
  return 'winter'; // Dec, Jan, Feb
}

export type HouseProfileForPrompt = {
  location: string;
  climateZone: string;
  propertyType: string;
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
  return [
    'House profile',
    `  Location: ${input.profile.location}`,
    `  Climate zone: ${input.profile.climateZone}`,
    `  Property type: ${input.profile.propertyType}`,
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
