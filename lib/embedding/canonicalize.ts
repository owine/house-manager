// Canonical text builders for each entity type. The output is what gets
// embedded by Voyage AND what the Ask LLM sees as context. Two design rules:
//
//   1. **Omit empty fields.** No `Manufacturer: undefined` lines — they
//      teach the model bad patterns and waste tokens. Helpers below skip
//      null/undefined/empty-string consistently.
//   2. **No PII or secrets.** Serial numbers, exact addresses, internal
//      IDs are deliberately excluded. Anything sensitive enough to redact
//      in Plan 4b's `buildInventoryBlock` is redacted here too.

// Minimal entity-shape types. Kept local (not imported from Prisma)
// because canonicalize is the one place that defines the canonical
// projection — adding a field to schema.prisma should not silently
// change embeddings; you must opt in here.

export type ItemForCanonical = {
  name: string;
  category: { name: string };
  system?: { name: string } | null;
  location?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  purchaseDate?: Date | null;
  purchasePrice?: number | string | null;
  metadata?: Record<string, unknown>;
  notes?: string | null;
};

export type NoteForCanonical = {
  title: string;
  body?: string | null;
  parent?: {
    kind: 'item' | 'system' | 'vendor' | 'serviceRecord';
    name: string;
  } | null;
  createdAt?: Date | null;
};

export type ServiceRecordForCanonical = {
  summary: string;
  performedOn?: Date | null;
  cost?: number | string | null;
  notes?: string | null;
  vendor?: { name: string } | null;
  freeformVendorName?: string | null;
  targets?: Array<{ item?: { name: string } | null; system?: { name: string } | null }>;
};

export type ChecklistItemForCanonical = {
  title: string;
  rationale?: string | null;
  completed: boolean;
  checklist: { name: string };
  item?: { name: string } | null;
};

export type WarrantyForCanonical = {
  provider: string;
  policyNumber?: string | null;
  coverage?: string | null;
  startsOn?: Date | null;
  endsOn?: Date | null;
  cost?: number | string | null;
  targets?: Array<{ item?: { name: string } | null; system?: { name: string } | null }>;
};

export type AttachmentForCanonical = {
  filename?: string | null;
  extractedText?: string | null;
  parent?: { kind: string; name: string } | null;
};

function fmtDate(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

function fmtMoney(n: number | string | null | undefined): string | null {
  if (n === null || n === undefined || n === '') return null;
  const num = typeof n === 'string' ? Number(n) : n;
  if (!Number.isFinite(num)) return null;
  return `$${num.toFixed(2)}`;
}

function present<T>(v: T | null | undefined): v is T {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string' && v.trim() === '') return false;
  return true;
}

function joinLines(lines: Array<string | null | undefined>): string {
  return lines.filter(present).join('\n');
}

export function canonicalizeItem(item: ItemForCanonical): string {
  const lines: Array<string | null> = [
    `Item: ${item.name}`,
    `Category: ${item.category.name}`,
    item.manufacturer ? `Manufacturer: ${item.manufacturer}` : null,
    item.model ? `Model: ${item.model}` : null,
    item.location ? `Location: ${item.location}` : null,
    item.system ? `System: ${item.system.name}` : null,
  ];
  const purchase = [fmtDate(item.purchaseDate ?? null), fmtMoney(item.purchasePrice ?? null)]
    .filter(present)
    .join(' for ');
  if (purchase) lines.push(`Purchased: ${purchase}`);

  if (item.metadata && Object.keys(item.metadata).length > 0) {
    const meta = Object.entries(item.metadata)
      .filter(([_, v]) => present(v))
      .map(([k, v]) => `  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    if (meta.length > 0) lines.push('Metadata:', ...meta);
  }
  if (item.notes) lines.push('Notes:', item.notes);
  return joinLines(lines);
}

export function canonicalizeNote(note: NoteForCanonical): string {
  const lines: Array<string | null> = [
    `Note: ${note.title}`,
    note.parent ? `Linked to ${note.parent.kind}: ${note.parent.name}` : null,
    note.createdAt ? `Created: ${fmtDate(note.createdAt)}` : null,
    '---',
    note.body ?? null,
  ];
  return joinLines(lines);
}

export function canonicalizeServiceRecord(sr: ServiceRecordForCanonical): string {
  const vendorName = sr.vendor?.name ?? sr.freeformVendorName ?? null;
  const targetNames = (sr.targets ?? []).map((t) => t.item?.name ?? t.system?.name).filter(present);
  const lines: Array<string | null> = [
    `Service: ${sr.summary}`,
    sr.performedOn ? `Performed: ${fmtDate(sr.performedOn)}` : null,
    vendorName ? `Vendor: ${vendorName}` : null,
    targetNames.length > 0 ? `Targets: ${targetNames.join(', ')}` : null,
    fmtMoney(sr.cost) ? `Cost: ${fmtMoney(sr.cost)}` : null,
    sr.notes ? '---' : null,
    sr.notes ?? null,
  ];
  return joinLines(lines);
}

export function canonicalizeChecklistItem(ci: ChecklistItemForCanonical): string {
  return joinLines([
    `Checklist: ${ci.checklist.name}`,
    `Item: ${ci.title}`,
    ci.item ? `Linked item: ${ci.item.name}` : null,
    ci.rationale ? `Rationale: ${ci.rationale}` : null,
    `Status: ${ci.completed ? 'completed' : 'pending'}`,
  ]);
}

export function canonicalizeWarranty(w: WarrantyForCanonical): string {
  const targetNames = (w.targets ?? []).map((t) => t.item?.name ?? t.system?.name).filter(present);
  return joinLines([
    `Warranty: ${w.provider}`,
    w.policyNumber ? `Policy: ${w.policyNumber}` : null,
    targetNames.length > 0 ? `Targets: ${targetNames.join(', ')}` : null,
    w.startsOn ? `Starts: ${fmtDate(w.startsOn)}` : null,
    w.endsOn ? `Ends: ${fmtDate(w.endsOn)}` : null,
    fmtMoney(w.cost) ? `Cost: ${fmtMoney(w.cost)}` : null,
    w.coverage ? '---' : null,
    w.coverage ?? null,
  ]);
}

export function canonicalizeAttachment(a: AttachmentForCanonical): string {
  if (!a.extractedText) return '';
  return joinLines([
    `Attachment: ${a.filename ?? '(unnamed)'}`,
    a.parent ? `Linked to ${a.parent.kind}: ${a.parent.name}` : null,
    '---',
    a.extractedText,
  ]);
}
