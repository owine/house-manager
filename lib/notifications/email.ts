import { getEnv } from '@/lib/env';

export type EmailPayload = {
  subject: string;
  text: string;
  html: string;
};

export type SendEmailResult = { ok: true } | { ok: false; reason: string };

export async function sendEmail(to: string, payload: EmailPayload): Promise<SendEmailResult> {
  const env = getEnv();
  const auth = Buffer.from(`${env.FORWARDEMAIL_API_KEY}:`).toString('base64');
  const res = await fetch('https://api.forwardemail.net/v1/emails', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.FORWARDEMAIL_FROM_ADDRESS,
      to,
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, reason: `${res.status} ${res.statusText}: ${body.slice(0, 200)}` };
  }
  return { ok: true };
}
