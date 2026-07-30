import { describe, expect, it } from 'vitest';

import { httpUrlSchema } from './http-url';

// These cases are the reason this schema exists. `z.string().url()` ACCEPTS
// every one of the dangerous ones — it validates URL syntax, not scheme
// safety — and all three consumers render their value into an `href`.
describe('httpUrlSchema', () => {
  it.each(['https://example.com', 'http://example.com/x?y=1', 'HTTPS://EXAMPLE.COM'])(
    'accepts %s',
    (url) => {
      expect(httpUrlSchema.safeParse(url).success).toBe(true);
    },
  );

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'ftp://example.com',
    'file:///etc/passwd',
    'example.com',
  ])('rejects %s', (url) => {
    expect(httpUrlSchema.safeParse(url).success).toBe(false);
  });
});
