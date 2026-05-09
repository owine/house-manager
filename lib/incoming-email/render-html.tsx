/**
 * Server-side sanitized HTML renderer for inbound vendor email bodies.
 *
 * The pipeline:
 *   1. Parse HTML → HAST (`hast-util-from-html`)
 *   2. Sanitize HAST in place (`hast-util-sanitize` w/ default GitHub schema)
 *   3. Convert sanitized HAST → React ReactNode (`hast-util-to-jsx-runtime`)
 *
 * The default sanitize schema is the same one rehype-sanitize uses: GitHub's
 * markdown-rendering allowlist. It strips <script>, <style>, inline event
 * handlers (onclick=, etc), javascript: URLs, and any tag/attribute not on
 * the explicit allowlist. Remote images are allowed via http(s) urls only.
 *
 * Image privacy hardening: we walk the sanitized tree and add
 * `loading="lazy"` + `referrerpolicy="no-referrer"` to every <img> so that
 * (a) images don't fetch until the user scrolls them into view, reducing
 * incidental tracking-pixel hits, and (b) the vendor doesn't get the
 * `housemanager.owine.net/inbox/...` URL leaked via Referer.
 */
import type { Element, Root } from 'hast';
import { fromHtml } from 'hast-util-from-html';
import { sanitize } from 'hast-util-sanitize';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import type { ReactNode } from 'react';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';

function hardenImages(tree: Root): void {
  const visit = (node: Root | Element): void => {
    if (node.type === 'element' && node.tagName === 'img') {
      node.properties = {
        ...node.properties,
        loading: 'lazy',
        referrerPolicy: 'no-referrer',
      };
    }
    for (const child of node.children ?? []) {
      if (child.type === 'element') visit(child);
    }
  };
  visit(tree);
}

export function renderSanitizedEmailHtml(html: string): ReactNode {
  // `fragment: true` parses the input as a fragment instead of wrapping in a
  // synthetic <html><body> — vendor-email bodies aren't full documents.
  const parsed = fromHtml(html, { fragment: true });
  // sanitize() returns a new tree with disallowed nodes removed; type assertion
  // because the lib's return type is broader than what we use.
  const clean = sanitize(parsed) as Root;
  hardenImages(clean);
  return toJsxRuntime(clean, { Fragment, jsx, jsxs });
}
