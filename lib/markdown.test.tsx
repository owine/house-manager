// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Markdown } from './markdown';

afterEach(() => cleanup());

describe('Markdown', () => {
  it('strips a leading blank line so the first heading is the first child', () => {
    const { container } = render(<Markdown>{'\n\n# Title\n\nBody'}</Markdown>);
    const root = container.querySelector('.markdown');
    expect(root?.firstElementChild?.tagName).toBe('H1');
    expect(root?.querySelector('p:empty')).toBeNull();
  });

  it('renders normal content unchanged', () => {
    render(<Markdown>{'Hello **world**'}</Markdown>);
    expect(screen.getByText('world').tagName).toBe('STRONG');
  });
});
