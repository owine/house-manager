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
    // The header-From domain mailauth evaluated. Optional here so dmarcResult
    // can still log a verdict; dmarcPassed requires it.
    domain: z.string().optional(),
  }),
});

/** The raw DMARC verdict, or null when the stored value isn't mailauth-shaped. For logs. */
export function dmarcResult(authResultsJson: unknown): string | null {
  const parsed = storedDmarcSchema.safeParse(authResultsJson);
  return parsed.success ? parsed.data.dmarc.status.result : null;
}

/**
 * True only when ForwardEmail recorded a DMARC pass for this message AND the
 * domain that pass was evaluated for is `fromAddress`'s domain.
 *
 * Ingest stores mailparser's first From mailbox, while mailauth picks its own
 * header From to evaluate. With two From mailboxes (or headers) they can name
 * different domains, so a pass for one must not vouch for the other.
 */
export function dmarcPassed(authResultsJson: unknown, fromAddress: string): boolean {
  const parsed = storedDmarcSchema.safeParse(authResultsJson);
  if (!parsed.success || parsed.data.dmarc.status.result !== 'pass') return false;
  const evaluated = parsed.data.dmarc.domain?.trim().toLowerCase();
  return evaluated !== undefined && evaluated === domainOf(fromAddress.trim());
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
  'yandex.com',
  'yandex.ru',
  'mail.ru',
  'tuta.com',
  'tutanota.com',
  // ISP mailboxes: every subscriber gets one, and small trades often use them.
  'comcast.net',
  'xfinity.com',
  'att.net',
  'sbcglobal.net',
  'bellsouth.net',
  'verizon.net',
  'cox.net',
  'charter.net',
  'spectrum.net',
  'earthlink.net',
  'frontier.com',
  'centurylink.net',
  'optonline.net',
  'windstream.net',
  'juno.com',
  'netzero.net',
  'rogers.com',
  'shaw.ca',
  'sympatico.ca',
  'btinternet.com',
  'sky.com',
  'virginmedia.com',
  't-online.de',
  'web.de',
  'orange.fr',
  'free.fr',
  'laposte.net',
  'libero.it',
  'bigpond.com',
  'optusnet.com.au',
]);

/**
 * Country and regional variants of the big providers (yahoo.co.uk, hotmail.fr,
 * outlook.de, gmx.de, …): one rule instead of a list that is always missing one.
 */
const SHARED_PROVIDER_VARIANT =
  /^(yahoo|ymail|rocketmail|hotmail|outlook|live|msn|gmx|aol|yandex|mail|zoho)\.[a-z]{2,3}(\.[a-z]{2})?$/;

function isSharedMailDomain(domain: string): boolean {
  return SHARED_MAIL_DOMAINS.has(domain) || SHARED_PROVIDER_VARIANT.test(domain);
}

/**
 * Billing / field-service platforms that send every merchant's mail from the
 * same addresses (QuickBooks invoices, Square receipts, …). A vendor whose
 * stored email is one of those addresses is not identified by it: any other
 * merchant on the platform sends from the identical address. Matched on the
 * domain and its subdomains, and never binds, even exactly.
 */
const PLATFORM_SENDER_DOMAINS = [
  'intuit.com',
  'quickbooks.com',
  'squareup.com',
  'square.com',
  'housecallpro.com',
  'servicetitan.com',
  'getjobber.com',
  'jobber.com',
  'stripe.com',
  'paypal.com',
  'bill.com',
  'freshbooks.com',
  'waveapps.com',
  'xero.com',
  'invoice2go.com',
  'joist.com',
];

function isPlatformSender(domain: string): boolean {
  return PLATFORM_SENDER_DOMAINS.some((p) => domain === p || domain.endsWith(`.${p}`));
}

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
  const from = domainOf(fromAddress.trim());
  if (from === null || isPlatformSender(from)) return false;
  if (fromAddress.trim().toLowerCase() === vendorEmail.trim().toLowerCase()) return true;
  return from === domainOf(vendorEmail.trim()) && !isSharedMailDomain(from);
}
