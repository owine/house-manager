'use client';

import type { ChatProposalKind, PartKind, Prisma } from '@prisma/client';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import type { ChatTurnProposal } from '@/lib/chat/actions';
import { parseCalendarDate } from '@/lib/chat/dates';
import type { ProposalPayload } from '@/lib/chat/schema';
import { formatCurrency } from '@/lib/format/currency';
import { formatCalendarDate } from '@/lib/format/date';
import { visibleMetadataEntries } from '@/lib/metadata/reserved-keys';
import { PART_KIND_LABELS } from '@/lib/parts/kind-labels';
import type { ActionResult } from '@/lib/result';
import { asCalendarDate } from '@/lib/time/tz';
import { DiffRow } from './DiffRow';

type ApplyOrRejectFn = (proposalId: unknown) => Promise<ActionResult<{ id: string }>>;
type RefreshFn = (proposalId: unknown) => Promise<ActionResult<{ proposal: ChatTurnProposal }>>;

export type ProposalCardProps = {
  proposal: ChatTurnProposal;
  applyProposal: ApplyOrRejectFn;
  rejectProposal: ApplyOrRejectFn;
  refreshProposal: RefreshFn;
};

const KIND_LABELS: Record<ChatProposalKind, string> = {
  CREATE_NOTE: 'New note',
  UPDATE_NOTE: 'Update note',
  CREATE_ITEM: 'New item',
  UPDATE_ITEM: 'Update item',
  UPDATE_SYSTEM: 'Update system',
  CREATE_SERVICE_RECORD: 'New service record',
  CREATE_PART: 'New part',
  UPDATE_PART: 'Update part',
};

// ORPHANED and INVALID share nothing — different cause, different remedy.
// Keep the wording distinct even though both are "you can't apply this".
const TERMINAL_MESSAGES: Record<string, string> = {
  ACCEPTED: 'This proposal has been applied.',
  REJECTED: 'This proposal was dismissed.',
  ORPHANED: 'The record this proposal refers to was deleted.',
  INVALID: 'This proposal predates a schema change and can no longer be applied.',
};

type Source = 'user' | 'inferred';

type ProvenancedValue = { value: string; source: Source };

type Row = {
  key: string;
  label: string;
  before?: string;
  after: string;
  source?: Source;
};

/** Format a model-supplied YYYY-MM-DD string; fall back to the raw value on parse failure. */
function fmtDate(value: string): string {
  const parsed = parseCalendarDate(value);
  return parsed ? formatCalendarDate(asCalendarDate(parsed)) : value;
}

/** Render a `PartKind` enum member as its label ("Air filter", not AIR_FILTER). */
function fmtPartKind(value: string): string {
  return PART_KIND_LABELS[value as PartKind] ?? value;
}

/**
 * A spec key rendered as a label, matching the part detail page's treatment
 * (`app/(app)/parts/[id]/tabs/OverviewTab.tsx`): short all-lowercase keys are
 * acronyms (merv, mpr, cri), everything else is camelCase split into words.
 */
function fmtSpecLabel(key: string): string {
  if (/^[a-z]{2,4}$/.test(key)) return key.toUpperCase();
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

function fmtSpecValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function asSnapshotRecord(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

/** Build the ordered diff rows for one proposal payload against its before-snapshot. */
function buildRows(payload: ProposalPayload, beforeSnapshot: Prisma.JsonValue | null): Row[] {
  const before = asSnapshotRecord(beforeSnapshot);
  const rows: Row[] = [];

  // `fmt` is applied to BOTH sides: the snapshot stores each field in the
  // payload's own wire format (YYYY-MM-DD, a fixed-2 decimal string, a raw
  // enum member), so before and after have to render through the same
  // function or an unchanged value shows up as a diff.
  const push = (
    key: string,
    label: string,
    field: ProvenancedValue | undefined,
    fmt: (value: string) => string = (v) => v,
  ) => {
    if (!field) return;
    const rawBefore = before[key];
    const beforeStr =
      rawBefore === undefined || rawBefore === null ? undefined : fmt(String(rawBefore));
    rows.push({
      key,
      label,
      before: beforeStr,
      after: fmt(field.value),
      source: field.source,
    });
  };

  /** Emit one row per user-visible spec key in the part's proposed `spec`. */
  const pushSpecs = (field: { value: Record<string, unknown>; source: Source } | undefined) => {
    if (!field) return;
    const beforeSpecs = asSnapshotRecord(before.spec);
    for (const [specKey, value] of visibleMetadataEntries(field.value)) {
      const rawBefore = beforeSpecs[specKey];
      rows.push({
        key: `spec.${specKey}`,
        label: fmtSpecLabel(specKey),
        before: rawBefore === undefined ? undefined : fmtSpecValue(rawBefore),
        after: fmtSpecValue(value),
        source: field.source,
      });
    }
  };

  switch (payload.kind) {
    case 'CREATE_NOTE':
      push('title', 'Title', payload.title);
      push('body', 'Body', payload.body);
      break;
    case 'UPDATE_NOTE':
      push('title', 'Title', payload.title);
      push('body', 'Body', payload.body);
      break;
    case 'CREATE_ITEM':
      push('name', 'Name', payload.name);
      push('manufacturer', 'Manufacturer', payload.manufacturer);
      push('model', 'Model', payload.model);
      push('serialNumber', 'Serial number', payload.serialNumber);
      push('location', 'Location', payload.location);
      push('purchaseDate', 'Purchase date', payload.purchaseDate, fmtDate);
      break;
    case 'UPDATE_ITEM':
      push('name', 'Name', payload.name);
      push('manufacturer', 'Manufacturer', payload.manufacturer);
      push('model', 'Model', payload.model);
      push('serialNumber', 'Serial number', payload.serialNumber);
      push('location', 'Location', payload.location);
      push('notes', 'Notes', payload.notes);
      push('purchaseDate', 'Purchase date', payload.purchaseDate, fmtDate);
      break;
    case 'UPDATE_SYSTEM':
      push('name', 'Name', payload.name);
      push('kindLabel', 'Kind', payload.kindLabel);
      push('location', 'Location', payload.location);
      push('notes', 'Notes', payload.notes);
      push('installDate', 'Install date', payload.installDate, fmtDate);
      break;
    case 'CREATE_SERVICE_RECORD':
      push('summary', 'Summary', payload.summary);
      push('performedOn', 'Performed on', payload.performedOn, fmtDate);
      push('notes', 'Notes', payload.notes);
      break;
    case 'CREATE_PART':
      push('name', 'Name', payload.name);
      push('partKind', 'Kind', payload.partKind, fmtPartKind);
      push('manufacturer', 'Manufacturer', payload.manufacturer);
      push('model', 'Model', payload.model);
      push('location', 'Location', payload.location);
      push('notes', 'Notes', payload.notes);
      push('typicalCost', 'Typical cost', payload.typicalCost, formatCurrency);
      // Parent link is create-only: re-parenting an existing part is a
      // PartLink edit, which UPDATE_PART has no arm for.
      if (payload.itemId) {
        rows.push({ key: 'itemId', label: 'Linked item', after: payload.itemId });
      }
      if (payload.systemId) {
        rows.push({ key: 'systemId', label: 'Linked system', after: payload.systemId });
      }
      pushSpecs(payload.spec);
      break;
    case 'UPDATE_PART':
      push('name', 'Name', payload.name);
      push('partKind', 'Kind', payload.partKind, fmtPartKind);
      push('manufacturer', 'Manufacturer', payload.manufacturer);
      push('model', 'Model', payload.model);
      push('location', 'Location', payload.location);
      push('notes', 'Notes', payload.notes);
      push('typicalCost', 'Typical cost', payload.typicalCost, formatCurrency);
      pushSpecs(payload.spec);
      break;
    default:
      // This switch is `case`/`break` over a discriminated union with a single
      // `return rows` below, so a missing kind is NOT a type error — it renders
      // a card with zero diff rows and nothing anywhere complains. The
      // `satisfies never` restores the check: add a proposal kind without an
      // arm here and this line stops compiling.
      payload satisfies never;
      break;
  }
  return rows;
}

export function ProposalCard({
  proposal: initialProposal,
  applyProposal,
  rejectProposal,
  refreshProposal,
}: ProposalCardProps) {
  const [proposal, setProposal] = useState(initialProposal);
  const [pending, startTransition] = useTransition();

  // INVALID means the stored payload no longer parses against the current
  // union (components/chat/proposal-mapping.ts substitutes a blank stub so
  // the type still checks out) — there is nothing meaningful to diff, skip rows.
  const rows =
    proposal.status === 'INVALID' ? [] : buildRows(proposal.payload, proposal.beforeSnapshot);
  const kindLabel = KIND_LABELS[proposal.kind];
  const terminalMessage = TERMINAL_MESSAGES[proposal.status];

  function handleApply() {
    startTransition(async () => {
      const result = await applyProposal(proposal.id);
      if (!result.ok) {
        toast.error(result.formError ?? 'Could not apply this proposal.');
        return;
      }
      setProposal((p) => ({ ...p, status: 'ACCEPTED' }));
      toast.success('Applied.');
    });
  }

  function handleReject() {
    startTransition(async () => {
      const result = await rejectProposal(proposal.id);
      if (!result.ok) {
        toast.error(result.formError ?? 'Could not reject this proposal.');
        return;
      }
      setProposal((p) => ({ ...p, status: 'REJECTED' }));
    });
  }

  function handleRefresh() {
    startTransition(async () => {
      const result = await refreshProposal(proposal.id);
      if (!result.ok) {
        toast.error(result.formError ?? 'Could not refresh this proposal.');
        return;
      }
      setProposal(result.data.proposal);
      toast.success('This record changed — review the new values below.');
    });
  }

  return (
    <Card size="sm" className="max-w-md">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {kindLabel}
          {proposal.status === 'STALE' && <Badge variant="outline">Changed</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {rows.map((row) => (
          <DiffRow
            key={row.key}
            label={row.label}
            before={row.before}
            after={row.after}
            source={row.source}
          />
        ))}
        {terminalMessage && <p className="text-sm text-muted-foreground">{terminalMessage}</p>}
      </CardContent>
      {(proposal.status === 'PENDING' || proposal.status === 'STALE') && (
        <CardFooter className="gap-2">
          {proposal.status === 'PENDING' && (
            <Button size="sm" onClick={handleApply} disabled={pending}>
              Accept
            </Button>
          )}
          {proposal.status === 'STALE' && (
            <Button size="sm" onClick={handleRefresh} disabled={pending}>
              Review changes
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={handleReject} disabled={pending}>
            Reject
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
