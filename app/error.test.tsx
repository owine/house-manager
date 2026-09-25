// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AppError from './error';
import GlobalError from './global-error';

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException }));

afterEach(() => {
  cleanup();
});

// A server-thrown error reaches the boundary as a redacted copy with a
// `digest`; onRequestError already reported the original on the server.
// Mutation-checked: dropping the digest check fails the "server" cases.
describe('error boundaries report browser errors only', () => {
  it('app/error.tsx reports a browser-thrown error', () => {
    const error = new Error('client render failed');
    render(<AppError error={error} reset={() => {}} />);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(error);
  });

  it('app/error.tsx does not re-report a server error (has a digest)', () => {
    const error = Object.assign(new Error('An error occurred in the Server Components render.'), {
      digest: '1234567890',
    });
    render(<AppError error={error} reset={() => {}} />);
    expect(captureException).not.toHaveBeenCalled();
  });

  it('app/global-error.tsx applies the same rule', () => {
    const server = Object.assign(new Error('redacted'), { digest: 'abc' });
    const { unmount } = render(<GlobalError error={server} reset={() => {}} />);
    expect(captureException).not.toHaveBeenCalled();
    unmount();

    const client = new Error('client');
    render(<GlobalError error={client} reset={() => {}} />);
    expect(captureException).toHaveBeenCalledWith(client);
  });
});
