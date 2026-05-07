import { describe, expect, it } from 'vitest';
import {
  buildHouseProfileBlock,
  buildInventoryBlock,
  buildSystemBlocks,
  coarsenLocation,
  formatInventoryLine,
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_VERSION,
  seasonForDate,
} from './prompts';

describe('SYSTEM_PROMPT_VERSION', () => {
  it('is a non-empty string', () => {
    expect(SYSTEM_PROMPT_VERSION).toMatch(/^v\d+/);
  });
});

describe('SYSTEM_PROMPT', () => {
  it('mentions privacy rule about not inventing items', () => {
    expect(SYSTEM_PROMPT).toMatch(/do not invent items/i);
  });

  it('mentions rationale requirement', () => {
    expect(SYSTEM_PROMPT).toMatch(/rationale/i);
  });
});

describe('seasonForDate', () => {
  it.each([
    ['2026-03-15', 'spring'],
    ['2026-06-21', 'summer'],
    ['2026-09-30', 'fall'],
    ['2026-12-15', 'winter'],
    ['2026-01-05', 'winter'],
  ] as const)('%s → %s', (date, expected) => {
    expect(seasonForDate(new Date(date))).toBe(expected);
  });
});

describe('coarsenLocation', () => {
  it('returns null for null input', () => {
    expect(coarsenLocation(null)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(coarsenLocation('')).toBeNull();
    expect(coarsenLocation('   ')).toBeNull();
  });

  it('leaves city/region unchanged', () => {
    expect(coarsenLocation('Austin, TX')).toBe('Austin, TX');
  });

  it('drops street address prefix with numbers', () => {
    expect(coarsenLocation('1234 Elm St, Austin, TX 78701')).toBe('Austin, TX');
  });

  it('drops apartment markers with numbers', () => {
    expect(coarsenLocation('Apt 5, 1234 Elm St, Austin, TX')).toBe('Austin, TX');
  });

  it('drops PO Box addresses', () => {
    expect(coarsenLocation('PO Box 123, Austin, TX')).toBe('Austin, TX');
  });

  it('drops trailing ZIP codes', () => {
    expect(coarsenLocation('Austin, TX 78701')).toBe('Austin, TX');
  });

  it('drops trailing ZIP+4 codes', () => {
    expect(coarsenLocation('Austin, TX 78701-1234')).toBe('Austin, TX');
  });

  it('drops street suffixes from segments starting with numbers', () => {
    expect(coarsenLocation('1234 Elm St, Austin, TX')).toBe('Austin, TX');
    expect(coarsenLocation('123 Main Blvd, Austin, TX')).toBe('Austin, TX');
    expect(coarsenLocation('999 Oak Dr, Austin, TX')).toBe('Austin, TX');
  });

  it('returns null when everything is stripped', () => {
    expect(coarsenLocation('1234 Elm St')).toBeNull();
    expect(coarsenLocation('Apt 5, PO Box 123')).toBeNull();
  });

  it('handles extra whitespace', () => {
    expect(coarsenLocation('  Austin  ,  TX  ')).toBe('Austin, TX');
    expect(coarsenLocation('1234 Elm St  ,  Austin  ,  TX  ')).toBe('Austin, TX');
  });

  it('handles Unit and Suite markers', () => {
    expect(coarsenLocation('Unit 12, 1234 Elm St, Austin, TX')).toBe('Austin, TX');
    expect(coarsenLocation('Suite 100, Austin, TX')).toBe('Austin, TX');
    expect(coarsenLocation('Ste 5, Austin, TX')).toBe('Austin, TX');
  });

  it('handles # abbreviation for unit', () => {
    expect(coarsenLocation('#5, 1234 Elm St, Austin, TX')).toBe('Austin, TX');
  });
});

describe('buildHouseProfileBlock', () => {
  it('includes location, climate zone, property type, today, season', () => {
    const block = buildHouseProfileBlock({
      profile: { location: 'Austin, TX', climateZone: '2A', propertyType: 'Single-family' },
      today: new Date('2026-04-15'),
    });
    expect(block).toContain('Austin, TX');
    expect(block).toContain('2A');
    expect(block).toContain('Single-family');
    expect(block).toContain('2026-04-15');
    expect(block).toContain('spring');
  });

  it('handles missing house profile gracefully', () => {
    const block = buildHouseProfileBlock({ profile: null, today: new Date('2026-04-15') });
    expect(block).toContain('not configured');
    expect(block).toContain('2026-04-15');
  });

  it('renders "not specified" for null fields in a partial profile', () => {
    const block = buildHouseProfileBlock({
      profile: { location: 'Austin, TX', climateZone: null, propertyType: null },
      today: new Date('2026-04-15'),
    });
    expect(block).toContain('Austin, TX');
    expect(block).toContain('Climate zone: not specified');
    expect(block).toContain('Property type: not specified');
  });
});

describe('formatInventoryLine', () => {
  it('produces pipe-delimited line with id, name, category, location, manufacturer+model', () => {
    const line = formatInventoryLine({
      id: 'cuid1',
      name: 'Carrier Furnace',
      categoryName: 'HVAC',
      location: 'Basement',
      manufacturer: 'Carrier',
      model: '58STA',
    });
    expect(line).toBe('- id=cuid1 | "Carrier Furnace" | HVAC | Basement | Carrier 58STA');
  });

  it('handles null fields with em-dashes', () => {
    const line = formatInventoryLine({
      id: 'cuid2',
      name: 'Mystery Tool',
      categoryName: 'Tool',
      location: null,
      manufacturer: null,
      model: null,
    });
    expect(line).toBe('- id=cuid2 | "Mystery Tool" | Tool | — | —');
  });
});

describe('buildInventoryBlock', () => {
  it('includes count and one line per item', () => {
    const block = buildInventoryBlock([
      { id: 'a', name: 'A', categoryName: 'X', location: 'L', manufacturer: 'M', model: 'N' },
      { id: 'b', name: 'B', categoryName: 'Y', location: null, manufacturer: null, model: null },
    ]);
    expect(block).toMatch(/Inventory \(2 items\)/);
    expect(block).toContain('- id=a |');
    expect(block).toContain('- id=b |');
  });

  it('says "no items" when empty', () => {
    const block = buildInventoryBlock([]);
    expect(block).toMatch(/no items/i);
  });
});

describe('buildSystemBlocks', () => {
  it('returns 3 blocks; cache_control on the last one only', () => {
    const blocks = buildSystemBlocks({
      profile: { location: 'A', climateZone: 'B', propertyType: 'C' },
      today: new Date('2026-04-15'),
      inventory: [],
    });
    expect(blocks).toHaveLength(3);
    expect(blocks[0].cache_control).toBeUndefined();
    expect(blocks[1].cache_control).toBeUndefined();
    expect(blocks[2].cache_control).toEqual({ type: 'ephemeral' });
  });
});
