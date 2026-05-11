/**
 * Heuristic classifier for inbound emails.
 *
 * Pure function — no DB calls, no I/O, no network. The caller loads
 * candidate Vendor/Item/System lists and passes them in. This keeps the
 * unit tests fixture-driven and lets a future Phase 5 swap an AI extractor
 * in at the worker layer without touching this code.
 *
 * Confidence floor for auto-stubbing a ServiceRecord: all three of
 * (kind=TICKET, vendor matched, item-or-system matched). Anything weaker
 * stays in the triage queue for the user.
 */

export type ClassifyVendor = {
  id: string;
  name: string;
  email: string | null;
  notes: string | null;
};

export type ClassifyEntity = { id: string; name: string };

export type ClassifyInput = {
  fromAddress: string;
  /**
   * The display name from the `From:` header (mailparser's `from.value[0].name`).
   * Used as a tertiary vendor-match path: many vendors send invoices through
   * billing platforms (QuickBooks, Stripe, Square) whose sender domain
   * doesn't match the vendor's own domain, but the platform sets the
   * display name to e.g. `"Acme HVAC via QuickBooks"`. Optional / nullable.
   */
  fromName: string | null;
  subject: string;
  bodyText: string;
  vendors: ClassifyVendor[];
  items: ClassifyEntity[];
  systems: ClassifyEntity[];
};

type ClassifyKind = 'ESTIMATE' | 'INVOICE' | 'TICKET' | 'UNKNOWN';

type ClassifyTarget = { itemId: string | null; systemId: string | null };

export type ClassifyResult = {
  kind: ClassifyKind;
  vendorId: string | null;
  /**
   * Targets the heuristic could confidently identify. v1 returns at most one
   * (the entity matcher picks a single best hit) but the array shape lets a
   * future enhancement return multiple without changing call sites.
   * Each target is item XOR system.
   */
  targets: ClassifyTarget[];
  shouldAutoStubServiceRecord: boolean;
};

// Order matters: INVOICE wins over ESTIMATE wins over TICKET. An email that
// reads "service ticket invoice" is more usefully classified as INVOICE since
// the financial side is the one needing user attention.
const KIND_PATTERNS: Array<{ kind: ClassifyKind; re: RegExp }> = [
  {
    kind: 'INVOICE',
    re: /\b(invoice|inv\s*#|amount\s+due|payment\s+due|paid\s+in\s+full)\b/i,
  },
  {
    kind: 'ESTIMATE',
    re: /\b(estimate|quote|proposal|bid)\b/i,
  },
  {
    kind: 'TICKET',
    re: /\b(service\s+(?:report|ticket|call|visit)|work\s+order|completed\s+service|maintenance\s+report)\b/i,
  },
];

const BODY_CLASSIFY_LIMIT = 500;
const BODY_ENTITY_LIMIT = 1000;

function domainOf(addr: string): string | null {
  const at = addr.lastIndexOf('@');
  if (at < 0 || at === addr.length - 1) return null;
  return addr.slice(at + 1).toLowerCase();
}

type VendorWithRegex = { vendor: ClassifyVendor; re: RegExp };

/**
 * Pre-compile name-match regexes once per classify call. matchVendor invokes
 * the by-name search up to twice (once against the From-display-name, once
 * against subject + body), so caching avoids O(2N) regex compiles. Vendors
 * with names < 3 chars are filtered out — same false-positive guard used
 * for entity matching.
 */
function compileVendorNameRegexes(vendors: ClassifyVendor[]): VendorWithRegex[] {
  const out: VendorWithRegex[] = [];
  for (const v of vendors) {
    const vendorName = v.name.trim();
    if (vendorName.length < 3) continue;
    out.push({ vendor: v, re: unicodeWordBoundaryRegex(vendorName) });
  }
  return out;
}

/**
 * Word-boundary case-insensitive vendor-name search against an arbitrary
 * haystack. Single-hit wins; 2+ distinct hits return null (ambiguous).
 */
function matchVendorByName(haystack: string, compiled: VendorWithRegex[]): ClassifyVendor | null {
  const hits: ClassifyVendor[] = [];
  for (const { vendor, re } of compiled) {
    if (re.test(haystack)) hits.push(vendor);
  }
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Resolve a vendor by sender. Tries, in order:
 *   1. Exact email match against Vendor.email
 *   2. Domain match: vendor's stored email shares the from-domain
 *   3. Notes substring: vendor's notes mention the from-domain (user-curated)
 *   4. Display-name match: from-header display name contains the vendor's
 *      own name as a whole word (covers "Acme HVAC via QuickBooks" senders)
 *   5. Subject + body match: when the email is delivered through a billing
 *      platform with no useful sender info (e.g. noreply@walkabout.software
 *      sending "Blue Sky Appliance Service Invoice"), look for the vendor
 *      name in the subject and body prefix
 *
 * Each fallback is more permissive than the last, so we use single-hit-wins
 * + ambiguity-bail to keep precision high. The body window mirrors the
 * one used for kind classification (BODY_CLASSIFY_LIMIT) — tightening the
 * search to the obviously-relevant prefix.
 */
function matchVendor(
  fromAddress: string,
  fromName: string | null,
  subject: string,
  bodyText: string,
  vendors: ClassifyVendor[],
): ClassifyVendor | null {
  const fromLower = fromAddress.toLowerCase();
  const exact = vendors.find((v) => v.email?.toLowerCase() === fromLower);
  if (exact) return exact;

  const fromDomain = domainOf(fromAddress);
  if (fromDomain) {
    for (const v of vendors) {
      if (v.email && domainOf(v.email) === fromDomain) return v;
      if (v.notes?.toLowerCase().includes(fromDomain)) return v;
    }
  }

  // Compile name regexes once for the two by-name fallback passes below.
  let compiled: VendorWithRegex[] | null = null;
  const getCompiled = () => {
    if (compiled === null) compiled = compileVendorNameRegexes(vendors);
    return compiled;
  };

  // Display-name fallback. Skip when fromName is empty/very short to avoid
  // false positives from mailers that omit the display name.
  if (fromName && fromName.trim().length >= 3) {
    const hit = matchVendorByName(fromName, getCompiled());
    if (hit) return hit;
  }

  // Subject + body-prefix fallback. Real-world: billing platforms send from
  // generic noreply addresses with no display name; the vendor name lives
  // in the subject ("Blue Sky Appliance Service Invoice") or body.
  const haystack = `${subject}\n${bodyText.slice(0, BODY_CLASSIFY_LIMIT)}`;
  const subjectHit = matchVendorByName(haystack, getCompiled());
  if (subjectHit) return subjectHit;

  return null;
}

function matchKind(subject: string, bodyText: string): ClassifyKind {
  const haystack = `${subject}\n${bodyText.slice(0, BODY_CLASSIFY_LIMIT)}`;
  for (const { kind, re } of KIND_PATTERNS) {
    if (re.test(haystack)) return kind;
  }
  return 'UNKNOWN';
}

/**
 * Escape regex special characters so a literal name can be safely embedded
 * in a regex pattern (e.g. "AC/DC", "X (1.0)").
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a Unicode-aware whole-word matcher for a literal name. Uses
 * `\p{L}\p{N}_` as the "word character" class so accented Latin
 * (Café, naïve), CJK, Cyrillic, etc. boundary-match the way humans
 * expect. JS's `\W` without the `u` flag is ASCII-only; the `iu`
 * flags here make matching case-insensitive and Unicode-correct.
 */
function unicodeWordBoundaryRegex(name: string): RegExp {
  const NON_WORD = '[^\\p{L}\\p{N}_]';
  return new RegExp(`(?:^|(?<=${NON_WORD}))${escapeRegex(name)}(?:$|(?=${NON_WORD}))`, 'iu');
}

type EntityHit = { id: string; matchLength: number; sourceLen: number };

function findEntityHits(haystack: string, entities: ClassifyEntity[]): EntityHit[] {
  const out: EntityHit[] = [];
  for (const e of entities) {
    const trimmed = e.name.trim();
    if (trimmed.length < 3) continue; // 1- and 2-char names produce too many false positives
    // Unicode-aware whole-word match: handles names with non-ASCII characters
    // (Café, naïve) and names with trailing non-word chars (X (1.0), AC/DC)
    // that plain \b can't anchor against.
    if (unicodeWordBoundaryRegex(trimmed).test(haystack)) {
      out.push({ id: e.id, matchLength: trimmed.length, sourceLen: trimmed.length });
    }
  }
  return out;
}

/**
 * Pick the single best entity match. Ties broken by longer match length
 * (more specific name). If multiple distinct entities match (e.g. a list
 * email mentioning several appliances), return null — the cost of a wrong
 * auto-link outweighs the convenience of any link.
 */
function pickBestEntity(hits: EntityHit[]): string | null {
  if (hits.length === 0) return null;
  if (hits.length === 1) return hits[0].id;
  const maxLen = Math.max(...hits.map((h) => h.matchLength));
  const longest = hits.filter((h) => h.matchLength === maxLen);
  if (longest.length === 1) return longest[0].id;
  // Multiple equally-long matches → ambiguous; bail.
  return null;
}

export function classifyEmail(input: ClassifyInput): ClassifyResult {
  const vendor = matchVendor(
    input.fromAddress,
    input.fromName,
    input.subject,
    input.bodyText,
    input.vendors,
  );
  const kind = matchKind(input.subject, input.bodyText);

  // Item/system matching is only attempted when a vendor matched. Without a
  // vendor anchor the false-positive rate goes up sharply (random list emails
  // mention product names without being about the user's specific instance).
  const targets: ClassifyTarget[] = [];
  if (vendor) {
    const haystack = `${input.subject}\n${input.bodyText.slice(0, BODY_ENTITY_LIMIT)}`;
    const itemHits = findEntityHits(haystack, input.items);
    const systemHits = findEntityHits(haystack, input.systems);
    const itemId = pickBestEntity(itemHits);
    let systemId = pickBestEntity(systemHits);
    // Item wins over system when both match — per-item is the more specific
    // link, matching the same precedence used by promoteToServiceRecord.
    if (itemId && systemId) systemId = null;
    if (itemId) targets.push({ itemId, systemId: null });
    else if (systemId) targets.push({ itemId: null, systemId });
  }

  const shouldAutoStubServiceRecord = kind === 'TICKET' && vendor !== null && targets.length > 0;

  return {
    kind,
    vendorId: vendor?.id ?? null,
    targets,
    shouldAutoStubServiceRecord,
  };
}
