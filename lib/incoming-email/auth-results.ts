import { z } from 'zod';

/**
 * Sender authentication for inbound email, read from `IncomingEmail.
 * authResultsJson`, which `ingestIncomingEmail` writes as `{ dkim, spf, dmarc }`.
 *
 * Those are ForwardEmail's mailauth results, passed through verbatim.
 * ForwardEmail's MX runs `mailauth.authenticate()` and copies `results.dmarc`
 * into the webhook body as `dmarc` (forwardemail.net helpers/
 * is-authenticated-message.js + on-data-mx.js). mailauth's DMARC verdict lives
 * at `status.result`: 'pass' | 'fail' | 'none' | 'temperror' (mailauth
 * docs/dmarc.md).
 *
 * FAIL-CLOSED. Only the exact string 'pass' at that path counts. A null
 * column, a missing key, mailauth's `false`, `none` (no DMARC record) and any
 * other shape all read as "not authenticated".
 */
const storedDmarcSchema = z.object({
  dmarc: z.object({
    status: z.object({ result: z.string() }),
  }),
});

/** The raw DMARC verdict, or null when the stored value isn't mailauth-shaped. For logs. */
export function dmarcResult(authResultsJson: unknown): string | null {
  const parsed = storedDmarcSchema.safeParse(authResultsJson);
  return parsed.success ? parsed.data.dmarc.status.result : null;
}

/** True only when ForwardEmail recorded a DMARC pass for this message. */
export function dmarcPassed(authResultsJson: unknown): boolean {
  return dmarcResult(authResultsJson) === 'pass';
}
