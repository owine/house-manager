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

/**
 * Mailbox providers whose domain anyone can sign up under. A DMARC pass for
 * `x@gmail.com` proves Google sent it, not which Gmail user — so a shared
 * domain binds a vendor only by its exact stored address.
 */
const SHARED_MAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'gmx.com',
  'gmx.net',
  'mail.com',
  'zoho.com',
  'fastmail.com',
  'hey.com',
]);

function domainOf(addr: string): string | null {
  const at = addr.lastIndexOf('@');
  if (at < 0 || at === addr.length - 1) return null;
  return addr.slice(at + 1).toLowerCase();
}

/**
 * True only when the (DMARC-authenticated) From address provably belongs to
 * this vendor: it IS the vendor's stored address, or shares its exact domain
 * and that domain is not a shared mailbox provider.
 *
 * DMARC authenticates the From *domain*; it says nothing about whether that
 * domain is the vendor's. Vendor matching, by contrast, is deliberately
 * permissive (notes mentioning the domain, display name, subject/body), and
 * on the AI path the vendor is a model output the email can steer. So a pass
 * from an attacker's own domain plus "Acme HVAC" in the subject used to be
 * enough to auto-stub a service record against Acme. Matching may still
 * PRE-FILL triage on those weaker signals; only this binding may auto-stub.
 */
export function senderBoundToVendor(
  fromAddress: string,
  vendorEmail: string | null | undefined,
): boolean {
  if (!vendorEmail) return false;
  if (fromAddress.trim().toLowerCase() === vendorEmail.trim().toLowerCase()) return true;
  const from = domainOf(fromAddress.trim());
  return from !== null && from === domainOf(vendorEmail.trim()) && !SHARED_MAIL_DOMAINS.has(from);
}
