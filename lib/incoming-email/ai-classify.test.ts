import { describe, expect, it } from 'vitest';
import { shouldAutoStub, validateCandidateIds } from './ai-classify';

describe('validateCandidateIds', () => {
  const vendors = [{ id: 'v1', name: 'Acme' }];
  const items = [{ id: 'i1', name: 'Furnace' }];
  const systems = [{ id: 's1', name: 'HVAC' }];
  it('keeps ids that exist in the candidate lists', () => {
    expect(
      validateCandidateIds(
        { vendorId: 'v1', targetItemId: 'i1', targetSystemId: null },
        { vendors, items, systems },
      ),
    ).toEqual({ vendorId: 'v1', targetItemId: 'i1', targetSystemId: null });
  });
  it('drops hallucinated ids to null', () => {
    expect(
      validateCandidateIds(
        { vendorId: 'v-nope', targetItemId: 'i-nope', targetSystemId: 's-nope' },
        { vendors, items, systems },
      ),
    ).toEqual({ vendorId: null, targetItemId: null, targetSystemId: null });
  });
  it('keeps item over system when both returned', () => {
    expect(
      validateCandidateIds(
        { vendorId: null, targetItemId: 'i1', targetSystemId: 's1' },
        { vendors, items, systems },
      ),
    ).toEqual({ vendorId: null, targetItemId: 'i1', targetSystemId: null });
  });
});

describe('shouldAutoStub', () => {
  const base = {
    vendorId: 'v1',
    targetItemId: 'i1',
    targetSystemId: null,
    confidence: 'high' as const,
  };
  it('stubs for TICKET and INVOICE at high confidence with vendor+target', () => {
    expect(shouldAutoStub({ ...base, kind: 'TICKET' })).toBe(true);
    expect(shouldAutoStub({ ...base, kind: 'INVOICE' })).toBe(true);
  });
  it('does not stub for ESTIMATE or UNKNOWN', () => {
    expect(shouldAutoStub({ ...base, kind: 'ESTIMATE' })).toBe(false);
    expect(shouldAutoStub({ ...base, kind: 'UNKNOWN' })).toBe(false);
  });
  it('does not stub below high confidence', () => {
    expect(shouldAutoStub({ ...base, kind: 'TICKET', confidence: 'medium' })).toBe(false);
  });
  it('does not stub without vendor or without a target', () => {
    expect(shouldAutoStub({ ...base, kind: 'TICKET', vendorId: null })).toBe(false);
    expect(
      shouldAutoStub({ ...base, kind: 'TICKET', targetItemId: null, targetSystemId: null }),
    ).toBe(false);
  });
});
