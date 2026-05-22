// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PendingAttachmentsField } from './PendingAttachmentsField';

afterEach(() => cleanup());

describe('PendingAttachmentsField', () => {
  it('adds and removes a link', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PendingAttachmentsField onChange={onChange} />);
    await user.type(screen.getByLabelText(/link url/i), 'https://example.com/paint');
    await user.type(screen.getByLabelText(/link label/i), 'Behr paint');
    await user.click(screen.getByRole('button', { name: /add link/i }));
    expect(screen.getByText('Behr paint')).toBeInTheDocument();
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        links: [{ url: 'https://example.com/paint', label: 'Behr paint' }],
      }),
    );
    await user.click(screen.getByRole('button', { name: /remove behr paint/i }));
    expect(screen.queryByText('Behr paint')).not.toBeInTheDocument();
  });

  it('rejects a non-http link', async () => {
    const user = userEvent.setup();
    render(<PendingAttachmentsField onChange={vi.fn()} />);
    await user.type(screen.getByLabelText(/link url/i), 'ftp://nope');
    await user.click(screen.getByRole('button', { name: /add link/i }));
    expect(screen.getByText(/must start with http/i)).toBeInTheDocument();
    expect(screen.queryByText('ftp://nope')).not.toBeInTheDocument();
  });

  it('rejects an over-size or wrong-type file', async () => {
    const user = userEvent.setup();
    render(<PendingAttachmentsField onChange={vi.fn()} />);
    const bad = new File(['x'], 'note.txt', { type: 'text/plain' });
    await user.upload(screen.getByLabelText(/add files/i), bad);
    expect(screen.getByText(/unsupported file type/i)).toBeInTheDocument();
  });
});
