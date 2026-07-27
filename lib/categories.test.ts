import { describe, expect, it } from 'vitest';

import { metadataSchemaFor } from './categories';

describe('freeformMetadataSchema (via metadataSchemaFor)', () => {
  it('accepts a normal scalar key', () => {
    const result = metadataSchemaFor('other').safeParse({ wattage: '9W' });
    expect(result.success).toBe(true);
  });

  it('rejects an underscore-prefixed key as reserved', () => {
    const result = metadataSchemaFor('other').safeParse({ _notes: 'text' });
    expect(result.success).toBe(false);
  });

  it('rejects an underscore-prefixed key via the unknown-slug fallback too', () => {
    const result = metadataSchemaFor('some-unknown-slug').safeParse({ _internal: 'x' });
    expect(result.success).toBe(false);
  });
});
