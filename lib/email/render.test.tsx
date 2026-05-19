import { describe, expect, it } from 'vitest';
import { Layout } from './layout';
import { renderEmail } from './render';

describe('renderEmail', () => {
  it('returns an html string starting with a doctype', () => {
    const { html } = renderEmail(
      <Layout appUrl="https://example.test">
        <p>hello</p>
      </Layout>,
    );
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<p>hello</p>');
  });

  it('produces no <style> tags (email-client safety contract)', () => {
    const { html } = renderEmail(
      <Layout appUrl="https://example.test">
        <p>hello</p>
      </Layout>,
    );
    expect(html).not.toMatch(/<style[\s>]/i);
  });

  it('produces no class/className attributes (email-client safety contract)', () => {
    const { html } = renderEmail(
      <Layout appUrl="https://example.test">
        <p>hello</p>
      </Layout>,
    );
    expect(html).not.toMatch(/\bclass\s*=/i);
    expect(html).not.toMatch(/\bclassName\s*=/i);
  });
});
