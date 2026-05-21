import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sendEmail } from './email';

// Mock env so sendEmail has a stable API key + from-address without validating
// the full env. Mirrors lib/embedding/voyage.test.ts.
vi.mock('@/lib/env', () => ({
  getEnv: () => ({
    FORWARDEMAIL_API_KEY: 'fe-test-key',
    FORWARDEMAIL_FROM_ADDRESS: 'house@example.com',
  }),
}));

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

const PAYLOAD = { subject: 'Overdue', text: 'plain body', html: '<p>html body</p>' };

describe('sendEmail', () => {
  it('POSTs to ForwardEmail with basic auth and the expected payload, returns ok', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    const result = await sendEmail('you@example.com', PAYLOAD);

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.forwardemail.net/v1/emails');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    // ForwardEmail uses HTTP basic auth: base64("<api-key>:") with empty password.
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('fe-test-key:').toString('base64')}`);
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init?.body as string)).toEqual({
      from: 'house@example.com',
      to: 'you@example.com',
      subject: 'Overdue',
      text: 'plain body',
      html: '<p>html body</p>',
    });
  });

  it('returns {ok:false} with status + statusText + body on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('invalid recipient', { status: 400, statusText: 'Bad Request' }),
    );

    const result = await sendEmail('bad', PAYLOAD);

    expect(result).toEqual({ ok: false, reason: '400 Bad Request: invalid recipient' });
  });

  it('truncates a long error body to 200 chars in the failure reason', async () => {
    const longBody = 'x'.repeat(500);
    fetchMock.mockResolvedValueOnce(
      new Response(longBody, { status: 500, statusText: 'Internal Server Error' }),
    );

    const result = await sendEmail('you@example.com', PAYLOAD);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe(`500 Internal Server Error: ${'x'.repeat(200)}`);
  });
});
