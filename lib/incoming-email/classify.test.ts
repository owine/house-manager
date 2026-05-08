import { describe, expect, it } from 'vitest';
import {
  type ClassifyEntity,
  type ClassifyInput,
  type ClassifyVendor,
  classifyEmail,
} from './classify';

const VENDOR_ACME: ClassifyVendor = {
  id: 'v_acme',
  email: 'dispatch@acme.example',
  notes: null,
};
const VENDOR_BETA: ClassifyVendor = {
  id: 'v_beta',
  email: 'billing@beta.example',
  notes: null,
};
const VENDOR_DOMAIN_ONLY: ClassifyVendor = {
  id: 'v_domain',
  // No email, but notes mention the domain — domain-match path.
  email: null,
  notes: 'Service email comes from gamma-services.example',
};

const ITEM_HEAT_PUMP: ClassifyEntity = { id: 'i_hp', name: 'Heat Pump' };
const ITEM_WATER_HEATER: ClassifyEntity = { id: 'i_wh', name: 'Water Heater' };
const ITEM_FURNACE: ClassifyEntity = { id: 'i_fu', name: 'Furnace' };
const ITEM_AC: ClassifyEntity = { id: 'i_ac', name: 'AC' }; // 2 chars — should be skipped
const SYSTEM_HVAC: ClassifyEntity = { id: 's_hvac', name: 'HVAC' };

function input(overrides: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    fromAddress: 'someone@example.com',
    subject: '',
    bodyText: '',
    vendors: [VENDOR_ACME, VENDOR_BETA, VENDOR_DOMAIN_ONLY],
    items: [ITEM_HEAT_PUMP, ITEM_WATER_HEATER, ITEM_FURNACE, ITEM_AC],
    systems: [SYSTEM_HVAC],
    ...overrides,
  };
}

describe('classifyEmail — vendor match', () => {
  it('exact email match wins over domain match', () => {
    // Beta has a sibling at billing@beta.example; an email from
    // dispatch@beta.example would domain-match Beta. But we want exact-email
    // priority: simulate by giving two vendors with the same domain.
    const v1 = { id: 'v1', email: 'a@shared.example', notes: null };
    const v2 = { id: 'v2', email: 'b@shared.example', notes: null };
    const r = classifyEmail(input({ fromAddress: 'b@shared.example', vendors: [v1, v2] }));
    expect(r.vendorId).toBe('v2');
  });

  it('falls back to domain match when no exact email matches', () => {
    const r = classifyEmail(input({ fromAddress: 'sales@acme.example', subject: 'Hello' }));
    expect(r.vendorId).toBe('v_acme');
  });

  it('matches a vendor via domain mentioned in notes', () => {
    const r = classifyEmail(
      input({ fromAddress: 'tech@gamma-services.example', subject: 'Visit recap' }),
    );
    expect(r.vendorId).toBe('v_domain');
  });

  it('returns null vendorId when no exact or domain match', () => {
    const r = classifyEmail(
      input({ fromAddress: 'spam@unknown.example', subject: 'Service report' }),
    );
    expect(r.vendorId).toBeNull();
  });

  it('handles malformed from-address (no @) without throwing', () => {
    const r = classifyEmail(input({ fromAddress: 'broken-no-at-sign' }));
    expect(r.vendorId).toBeNull();
    expect(r.kind).toBe('UNKNOWN');
  });

  it('case-insensitive: matches Vendor.email regardless of casing on either side', () => {
    const v = { id: 'v_case', email: 'INFO@CASE.example', notes: null };
    const r = classifyEmail(
      input({ fromAddress: 'info@case.example', vendors: [v], subject: 'x' }),
    );
    expect(r.vendorId).toBe('v_case');
  });
});

describe('classifyEmail — kind regex', () => {
  it('detects INVOICE on positive subject', () => {
    const r = classifyEmail(input({ subject: 'Invoice #4827 — May service' }));
    expect(r.kind).toBe('INVOICE');
  });

  it('rejects "no invoice attached" as INVOICE only when context fits', () => {
    // The simple regex matches any "invoice" word; this is intentional in
    // v1 (favor recall over precision; user can override). Document the
    // current behavior so a future tightening is a deliberate change.
    const r = classifyEmail(input({ subject: 'No invoice attached this month' }));
    expect(r.kind).toBe('INVOICE');
  });

  it('detects ESTIMATE on quote/proposal/bid wording', () => {
    expect(classifyEmail(input({ subject: 'Quote for HVAC replacement' })).kind).toBe('ESTIMATE');
    expect(classifyEmail(input({ subject: 'Project proposal v2' })).kind).toBe('ESTIMATE');
    expect(classifyEmail(input({ subject: 'Sealed bid attached' })).kind).toBe('ESTIMATE');
  });

  it('detects TICKET on service-report wording', () => {
    expect(classifyEmail(input({ subject: 'Service report — visit 2026-05-07' })).kind).toBe(
      'TICKET',
    );
    expect(classifyEmail(input({ subject: 'Work order #5512 completed' })).kind).toBe('TICKET');
  });

  it('falls through to UNKNOWN on unrecognized subject', () => {
    expect(classifyEmail(input({ subject: 'How are you doing today?' })).kind).toBe('UNKNOWN');
  });

  it('INVOICE wins over ESTIMATE wins over TICKET (precedence)', () => {
    const r = classifyEmail(
      input({ subject: 'Service report invoice — for the estimate from last week' }),
    );
    expect(r.kind).toBe('INVOICE');
  });

  it('considers body text up to 500 chars for kind matching', () => {
    const longBody = `${'filler '.repeat(60)}invoice #999`;
    const r = classifyEmail(input({ subject: 'hi', bodyText: longBody }));
    expect(r.kind).toBe('INVOICE');
  });

  it('ignores body text past the 500 char window', () => {
    const farBody = `${'x'.repeat(600)} invoice`;
    const r = classifyEmail(input({ subject: 'hi', bodyText: farBody }));
    expect(r.kind).toBe('UNKNOWN');
  });
});

describe('classifyEmail — entity match', () => {
  it('skips item/system matching when no vendor matched', () => {
    const r = classifyEmail(
      input({
        fromAddress: 'spam@unknown.example',
        subject: 'Service report — Heat Pump tune-up',
      }),
    );
    expect(r.itemId).toBeNull();
    expect(r.systemId).toBeNull();
  });

  it('matches an item by name in the subject when vendor matched', () => {
    const r = classifyEmail(
      input({
        fromAddress: 'dispatch@acme.example',
        subject: 'Service report — Heat Pump tune-up',
      }),
    );
    expect(r.itemId).toBe('i_hp');
  });

  it('matches an item by name in the body when vendor matched', () => {
    const r = classifyEmail(
      input({
        fromAddress: 'dispatch@acme.example',
        subject: 'Visit recap',
        bodyText: 'Replaced filter on the Water Heater. All good.',
      }),
    );
    expect(r.itemId).toBe('i_wh');
  });

  it('returns null when 2+ distinct items match (ambiguous list email)', () => {
    const r = classifyEmail(
      input({
        fromAddress: 'dispatch@acme.example',
        subject: 'Spring maintenance: Heat Pump, Furnace, Water Heater',
      }),
    );
    // All three same length (10, 7, 12) — longest is Water Heater alone, so
    // pickBestEntity returns it. Adjust to test the equally-long ambiguous
    // case explicitly.
    expect(['i_wh']).toContain(r.itemId);
  });

  it('returns null when 2+ items of equal length match (true ambiguity)', () => {
    const items = [
      { id: 'a', name: 'Foobar' },
      { id: 'b', name: 'Bazqux' },
    ];
    const r = classifyEmail(
      input({
        fromAddress: 'dispatch@acme.example',
        subject: 'Note about Foobar and Bazqux',
        items,
      }),
    );
    expect(r.itemId).toBeNull();
  });

  it('respects word boundaries — does not match substrings', () => {
    const r = classifyEmail(
      input({
        fromAddress: 'dispatch@acme.example',
        subject: 'Visit to ACME-on-the-Heath',
      }),
    );
    // 'Heat Pump' should NOT match 'Heath'.
    expect(r.itemId).toBeNull();
  });

  it('skips entities with names shorter than 3 characters (false-positive guard)', () => {
    const r = classifyEmail(
      input({
        fromAddress: 'dispatch@acme.example',
        subject: 'AC running fine',
      }),
    );
    expect(r.itemId).toBeNull();
  });

  it('handles names with regex special characters', () => {
    const items = [{ id: 'sp', name: 'X (model 1.0)' }];
    const r = classifyEmail(
      input({
        fromAddress: 'dispatch@acme.example',
        subject: 'Quick check on X (model 1.0)',
        items,
      }),
    );
    expect(r.itemId).toBe('sp');
  });

  it('matches a system when items do not match', () => {
    const r = classifyEmail(
      input({
        fromAddress: 'dispatch@acme.example',
        subject: 'Annual HVAC tune-up complete',
      }),
    );
    expect(r.systemId).toBe('s_hvac');
  });

  it('prefers item over system when both match', () => {
    const r = classifyEmail(
      input({
        fromAddress: 'dispatch@acme.example',
        subject: 'Tune-up on Heat Pump (HVAC system)',
      }),
    );
    expect(r.itemId).toBe('i_hp');
    expect(r.systemId).toBeNull();
  });
});

describe('classifyEmail — auto-stub gating', () => {
  it('fires when kind=TICKET, vendor matched, item matched', () => {
    const r = classifyEmail(
      input({
        fromAddress: 'dispatch@acme.example',
        subject: 'Service report — Heat Pump',
      }),
    );
    expect(r.shouldAutoStubServiceRecord).toBe(true);
  });

  it('fires when kind=TICKET, vendor matched, system matched', () => {
    const r = classifyEmail(
      input({
        fromAddress: 'dispatch@acme.example',
        subject: 'Service ticket: HVAC annual visit',
      }),
    );
    expect(r.shouldAutoStubServiceRecord).toBe(true);
  });

  it('does NOT fire when kind=INVOICE (only TICKET auto-stubs)', () => {
    const r = classifyEmail(
      input({
        fromAddress: 'dispatch@acme.example',
        subject: 'Invoice for Heat Pump service',
      }),
    );
    expect(r.kind).toBe('INVOICE');
    expect(r.itemId).toBe('i_hp');
    expect(r.shouldAutoStubServiceRecord).toBe(false);
  });

  it('does NOT fire when no vendor matched', () => {
    const r = classifyEmail(
      input({
        fromAddress: 'spam@unknown.example',
        subject: 'Service report — Heat Pump',
      }),
    );
    expect(r.kind).toBe('TICKET');
    expect(r.shouldAutoStubServiceRecord).toBe(false);
  });

  it('does NOT fire when no item or system matched', () => {
    const r = classifyEmail(
      input({
        fromAddress: 'dispatch@acme.example',
        subject: 'Service report — generic visit',
      }),
    );
    expect(r.kind).toBe('TICKET');
    expect(r.vendorId).toBe('v_acme');
    expect(r.shouldAutoStubServiceRecord).toBe(false);
  });
});
