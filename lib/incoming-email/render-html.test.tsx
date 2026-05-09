import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { renderSanitizedEmailHtml } from './render-html';

function render(html: string): string {
  return renderToStaticMarkup(renderSanitizedEmailHtml(html));
}

describe('renderSanitizedEmailHtml', () => {
  it('renders simple HTML', () => {
    expect(render('<p>Hello <strong>world</strong>.</p>')).toBe(
      '<p>Hello <strong>world</strong>.</p>',
    );
  });

  it('strips <script> tags', () => {
    const out = render('<p>safe</p><script>alert(1)</script>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
    expect(out).toContain('<p>safe</p>');
  });

  it('strips inline event handlers', () => {
    // hast-util-sanitize default schema removes any attribute not on the
    // allowlist; on* handlers aren't on it, so they're dropped wholesale.
    const out = render('<a href="https://example.com" onclick="evil()">x</a>');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('evil');
  });

  it('strips javascript: URLs', () => {
    const out = render('<a href="javascript:alert(1)">click</a>');
    expect(out).not.toContain('javascript:');
  });

  it('strips style attributes', () => {
    const out = render('<p style="color:red">x</p>');
    expect(out).not.toContain('style=');
  });

  it('strips <style> tags', () => {
    const out = render('<style>.x{color:red}</style><p>x</p>');
    expect(out).not.toContain('<style');
  });

  it('strips <iframe> tags', () => {
    const out = render('<iframe src="https://evil.example"></iframe><p>x</p>');
    expect(out).not.toContain('<iframe');
    expect(out).toContain('<p>x</p>');
  });

  it('keeps http/https image src', () => {
    const out = render('<img src="https://example.com/logo.png" alt="logo"/>');
    expect(out).toContain('src="https://example.com/logo.png"');
  });

  it('hardens images with loading=lazy and referrerpolicy=no-referrer', () => {
    const out = render('<img src="https://example.com/x.png" alt="x"/>');
    expect(out).toContain('loading="lazy"');
    // React uses camelCase JSX prop names in renderToStaticMarkup; the DOM
    // attribute name is lowercased at hydration. Either way the resulting
    // HTML attr in the user's browser is `referrerpolicy`.
    expect(out.toLowerCase()).toContain('referrerpolicy="no-referrer"');
  });

  it('strips data: URLs on images (sanitize default rejects non-http schemes)', () => {
    const out = render('<img src="data:image/png;base64,iVBORw0KGgo=" alt="evil"/>');
    expect(out).not.toContain('data:image');
  });

  it('keeps tables (vendor invoices use them heavily)', () => {
    const out = render(
      '<table><thead><tr><th>Item</th></tr></thead><tbody><tr><td>$10</td></tr></tbody></table>',
    );
    expect(out).toContain('<table>');
    expect(out).toContain('<td>$10</td>');
  });

  it('keeps lists', () => {
    const out = render('<ul><li>a</li><li>b</li></ul>');
    expect(out).toContain('<ul>');
    expect(out).toContain('<li>a</li>');
  });

  it('keeps anchor href + text', () => {
    const out = render('<a href="https://example.com">link</a>');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('>link</a>');
  });

  it('handles fragment input (no <html><body> wrapper)', () => {
    const out = render('<p>just a fragment</p>');
    expect(out).not.toContain('<html');
    expect(out).not.toContain('<body');
    expect(out).toBe('<p>just a fragment</p>');
  });

  it('treats malformed HTML as best-effort fragment', () => {
    // Unclosed tag — parser auto-closes; sanitize still applies.
    const out = render('<p>open<script>bad</script>');
    expect(out).not.toContain('<script');
    expect(out).toContain('open');
  });

  it('hardens nested images inside other elements', () => {
    const out = render('<div><p><img src="https://e.example/a.png"/></p></div>');
    expect(out).toContain('loading="lazy"');
  });

  it('returns null for input exceeding the size cap', () => {
    // 1.1 MB > 1 MB cap. Use a benign repeated paragraph to keep the test
    // fast (no parser involvement on the rejected path).
    const big = '<p>x</p>'.repeat(150_000);
    const result = renderSanitizedEmailHtml(big);
    expect(result).toBeNull();
  });

  it('accepts input at the size boundary', () => {
    // Exactly the cap should still render; cap uses '>' (strict).
    const exactly = 'a'.repeat(1_000_000);
    const result = renderSanitizedEmailHtml(exactly);
    expect(result).not.toBeNull();
  });
});
