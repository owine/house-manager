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
  email: string | null;
  notes: string | null;
};

export type ClassifyEntity = { id: string; name: string };

export type ClassifyInput = {
  fromAddress: string;
  subject: string;
  bodyText: string;
  vendors: ClassifyVendor[];
  items: ClassifyEntity[];
  systems: ClassifyEntity[];
};

export type ClassifyKind = 'ESTIMATE' | 'INVOICE' | 'TICKET' | 'UNKNOWN';

export type ClassifyResult = {
  kind: ClassifyKind;
  vendorId: string | null;
  itemId: string | null;
  systemId: string | null;
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

/**
 * Resolve a vendor by sender. Order: exact email match, then domain match
 * against any vendor's email or notes (case-insensitive substring).
 */
function matchVendor(fromAddress: string, vendors: ClassifyVendor[]): ClassifyVendor | null {
  const fromLower = fromAddress.toLowerCase();
  const exact = vendors.find((v) => v.email?.toLowerCase() === fromLower);
  if (exact) return exact;

  const fromDomain = domainOf(fromAddress);
  if (!fromDomain) return null;

  // Domain match: any vendor whose stored email shares the from-domain, OR
  // whose notes mention the from-domain. Notes are user-curated, so a vendor
  // with notes "Service email comes from billing@acmehvac.example" matches.
  for (const v of vendors) {
    if (v.email && domainOf(v.email) === fromDomain) return v;
    if (v.notes?.toLowerCase().includes(fromDomain)) return v;
  }
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
 * Word-boundary case-insensitive substring search. Names with regex special
 * characters (e.g. "AC/DC", "X (1.0)") need to be escaped before being
 * dropped into the regex.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type EntityHit = { id: string; matchLength: number; sourceLen: number };

function findEntityHits(haystack: string, entities: ClassifyEntity[]): EntityHit[] {
  const out: EntityHit[] = [];
  for (const e of entities) {
    const trimmed = e.name.trim();
    if (trimmed.length < 3) continue; // 1- and 2-char names produce too many false positives
    // Use lookarounds instead of \b so names with trailing non-word chars
    // (e.g. "X (model 1.0)" or "AC/DC") still match. \b only fires at
    // word↔non-word transitions, which fails when the name itself ends in
    // a non-word character.
    const re = new RegExp(`(?:^|(?<=\\W))${escapeRegex(trimmed)}(?:$|(?=\\W))`, 'i');
    if (re.test(haystack)) {
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
  const vendor = matchVendor(input.fromAddress, input.vendors);
  const kind = matchKind(input.subject, input.bodyText);

  // Item/system matching is only attempted when a vendor matched. Without a
  // vendor anchor the false-positive rate goes up sharply (random list emails
  // mention product names without being about the user's specific instance).
  let itemId: string | null = null;
  let systemId: string | null = null;
  if (vendor) {
    const haystack = `${input.subject}\n${input.bodyText.slice(0, BODY_ENTITY_LIMIT)}`;
    const itemHits = findEntityHits(haystack, input.items);
    const systemHits = findEntityHits(haystack, input.systems);
    itemId = pickBestEntity(itemHits);
    systemId = pickBestEntity(systemHits);
    // Item wins over system when both match — per-item is the more specific
    // link, matching the same precedence used by promoteToServiceRecord.
    if (itemId && systemId) systemId = null;
  }

  const shouldAutoStubServiceRecord =
    kind === 'TICKET' && vendor !== null && (itemId !== null || systemId !== null);

  return {
    kind,
    vendorId: vendor?.id ?? null,
    itemId,
    systemId,
    shouldAutoStubServiceRecord,
  };
}
