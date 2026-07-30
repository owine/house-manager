import { z } from 'zod';

/**
 * A URL that is safe to render as an `href`.
 *
 * `z.string().url()` alone is NOT that. Verified against the pinned zod:
 *
 *   example.com            rejected
 *   javascript:alert(1)    ACCEPTED
 *   data:text/html,x       ACCEPTED
 *   ftp://example.com      ACCEPTED
 *
 * It checks that the string parses as a URL, not that its scheme is one you
 * want to hand to a browser. Any field validated with a bare `.url()` and then
 * rendered into an `href` is a stored-XSS vector.
 *
 * Use this for every user-supplied URL that ends up in markup. Three fields do
 * today: external attachment links, part purchase links, and vendor websites.
 */
export const httpUrlSchema = z
  .string()
  .url()
  .refine((s) => /^https?:\/\//i.test(s), 'URL must use http:// or https://');
