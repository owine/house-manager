import { describe, expect, it } from 'vitest';
import { stripInlineCitationTags } from './strip-tags';

describe('stripInlineCitationTags', () => {
  it('removes [SERVICE_RECORD cuid] tags', () => {
    const input = 'Pest control came January 16, 2026 [SERVICE_RECORD cmp0n3k0r00010jb2fyuj60xo].';
    expect(stripInlineCitationTags(input)).toBe('Pest control came January 16, 2026.');
  });

  it('removes [ITEM cuid] tags too', () => {
    expect(stripInlineCitationTags('The HVAC system [ITEM cmoabc123].')).toBe('The HVAC system.');
  });

  it('removes bare [SERVICE_RECORD] tags with no id', () => {
    expect(stripInlineCitationTags('The pest visit happened [SERVICE_RECORD].')).toBe(
      'The pest visit happened.',
    );
  });

  it('removes (entityId=cuid) parenthetical leaks', () => {
    expect(
      stripInlineCitationTags('Rose Pest Solutions (entityId=cmp0n3bk800000jb2bkt3nodr).'),
    ).toBe('Rose Pest Solutions.');
  });

  it('removes (entityType=SERVICE_RECORD entityId=cuid) parenthetical leaks', () => {
    expect(
      stripInlineCitationTags('see record (entityType=SERVICE_RECORD entityId=cmp0n3bk8).'),
    ).toBe('see record.');
  });

  it('leaves clean prose untouched', () => {
    const clean = 'Pest control has come **three times** to your home this year.';
    expect(stripInlineCitationTags(clean)).toBe(clean);
  });

  it('handles multiple tags in one string', () => {
    const input =
      'Jan 16 [SERVICE_RECORD a1], Apr 7 [SERVICE_RECORD b2], Apr 15 [SERVICE_RECORD c3].';
    expect(stripInlineCitationTags(input)).toBe('Jan 16, Apr 7, Apr 15.');
  });

  it('is idempotent', () => {
    const once = stripInlineCitationTags('Done [SERVICE_RECORD abc] today.');
    const twice = stripInlineCitationTags(once);
    expect(twice).toBe(once);
  });
});
