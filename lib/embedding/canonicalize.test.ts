import { describe, expect, it } from 'vitest';

import {
  canonicalizeAttachment,
  canonicalizeChecklistItem,
  canonicalizeItem,
  canonicalizeNote,
  canonicalizeServiceRecord,
  canonicalizeWarranty,
} from './canonicalize';

describe('canonicalizeItem', () => {
  it('renders only present fields and includes metadata key:value lines', () => {
    const out = canonicalizeItem({
      name: 'Carrier 58STA',
      category: { name: 'HVAC' },
      manufacturer: 'Carrier',
      model: '58STA',
      location: 'Basement',
      system: { name: 'HVAC system' },
      purchaseDate: new Date('2026-01-15'),
      purchasePrice: 4500,
      metadata: { btu: 60000, seer: 16, fuelType: 'gas' },
      notes: 'Annual filter change every 90 days.',
    });
    expect(out).toContain('Item: Carrier 58STA');
    expect(out).toContain('Category: HVAC');
    expect(out).toContain('Manufacturer: Carrier');
    expect(out).toContain('Location: Basement');
    expect(out).toContain('System: HVAC system');
    expect(out).toContain('Purchased: 2026-01-15 for $4500.00');
    expect(out).toContain('Metadata:');
    expect(out).toContain('  btu: 60000');
    expect(out).toContain('  fuelType: gas');
    expect(out).toContain('Annual filter change');
  });

  it('omits empty fields completely', () => {
    const out = canonicalizeItem({
      name: 'Mystery box',
      category: { name: 'Other' },
    });
    expect(out).toBe('Item: Mystery box\nCategory: Other');
    expect(out).not.toContain('Manufacturer');
    expect(out).not.toContain('Metadata');
  });

  it('does not include serialNumber even when present in shape', () => {
    // Caller can pass extra fields — the canonical builder must not pick them up.
    // We pass via `as any` to simulate an extended shape.
    const out = canonicalizeItem({
      name: 'Furnace',
      category: { name: 'HVAC' },
      // biome-ignore lint/suspicious/noExplicitAny: testing redaction surface
      ...({ serialNumber: '00CAR123-SECRET' } as any),
    });
    expect(out).not.toContain('SECRET');
    expect(out).not.toContain('serialNumber');
  });
});

describe('canonicalizeNote', () => {
  it('includes title, parent reference, and body', () => {
    const out = canonicalizeNote({
      title: 'Furnace tune-up notes',
      body: 'Tech said the blower wheel is dirty.',
      parent: { kind: 'item', name: 'Carrier 58STA' },
      createdAt: new Date('2026-04-12'),
    });
    expect(out).toContain('Note: Furnace tune-up notes');
    expect(out).toContain('Linked to item: Carrier 58STA');
    expect(out).toContain('blower wheel');
  });

  it('omits parent line when not provided', () => {
    const out = canonicalizeNote({ title: 'General note', body: 'hello' });
    expect(out).not.toContain('Linked to');
  });
});

describe('canonicalizeServiceRecord', () => {
  it('flattens targets and includes vendor + cost + notes', () => {
    const out = canonicalizeServiceRecord({
      summary: 'Annual spring tune-up',
      performedOn: new Date('2026-04-12'),
      cost: 220,
      notes: 'Replaced air filter; system runs clean.',
      vendor: { name: 'GreenLawn LLC' },
      targets: [{ item: { name: 'Carrier 58STA' } }, { system: { name: 'HVAC system' } }],
    });
    expect(out).toContain('Service: Annual spring tune-up');
    expect(out).toContain('Vendor: GreenLawn LLC');
    expect(out).toContain('Targets: Carrier 58STA, HVAC system');
    expect(out).toContain('Cost: $220.00');
    expect(out).toContain('Replaced air filter');
  });

  it('uses freeform vendor name as fallback', () => {
    const out = canonicalizeServiceRecord({
      summary: 'Lawn',
      freeformVendorName: 'Local crew',
    });
    expect(out).toContain('Vendor: Local crew');
  });
});

describe('canonicalizeChecklistItem', () => {
  it('shows checklist and rationale', () => {
    const out = canonicalizeChecklistItem({
      title: 'Test sump pump',
      rationale: 'Spring rains start mid-April.',
      completed: false,
      checklist: { name: 'Spring 2026' },
      item: { name: 'Basement sump' },
    });
    expect(out).toContain('Checklist: Spring 2026');
    expect(out).toContain('Item: Test sump pump');
    expect(out).toContain('Linked item: Basement sump');
    expect(out).toContain('Spring rains');
    expect(out).toContain('Status: pending');
  });
});

describe('canonicalizeWarranty', () => {
  it('formats dates and includes coverage block', () => {
    const out = canonicalizeWarranty({
      provider: 'Carrier 10-yr parts',
      policyNumber: 'POLICY-123',
      coverage: 'Manufacturer parts only. Excludes labor.',
      startsOn: new Date('2024-01-15'),
      endsOn: new Date('2034-01-15'),
      targets: [{ item: { name: 'Carrier 58STA' } }],
    });
    expect(out).toContain('Warranty: Carrier 10-yr parts');
    expect(out).toContain('Policy: POLICY-123');
    expect(out).toContain('Starts: 2024-01-15');
    expect(out).toContain('Ends: 2034-01-15');
    expect(out).toContain('Manufacturer parts only');
  });
});

describe('canonicalizeAttachment', () => {
  it('returns empty string when extractedText is empty', () => {
    expect(canonicalizeAttachment({ filename: 'x.pdf' })).toBe('');
    expect(canonicalizeAttachment({ filename: 'x.pdf', extractedText: '' })).toBe('');
  });

  it('emits filename + parent + body when text is present', () => {
    const out = canonicalizeAttachment({
      filename: 'invoice.pdf',
      extractedText: 'INVOICE #A4396577 ROSE PEST SOLUTIONS',
      parent: { kind: 'serviceRecord', name: 'Spring tune-up' },
    });
    expect(out).toContain('Attachment: invoice.pdf');
    expect(out).toContain('Linked to serviceRecord: Spring tune-up');
    expect(out).toContain('ROSE PEST SOLUTIONS');
  });
});
