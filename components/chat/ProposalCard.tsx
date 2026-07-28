'use client';

import type { ChatProposalKind, Prisma } from '@prisma/client';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import type { ChatTurnProposal } from '@/lib/chat/actions';
import { parseCalendarDate } from '@/lib/chat/dates';
import type { ProposalPayload } from '@/lib/chat/schema';
import { formatCalendarDate } from '@/lib/format/date';
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
};

// ORPHANED and INVALID share nothing — different cause, different remedy.
// Keep the wording distinct even though both are "you can't apply this".
const TERMINAL_MESSAGES: Record<string, string> = {
  ACCEPTED: 'This proposal has been applied.',
  REJECTED: 'This proposal was dismissed.',
  ORPHANED: 'The record this proposal refers to was deleted.',
  INVALID: 'This proposal predates a schema change and can no longer be applied.',
};

type ProvenancedValue = { value: string; source: 'user' | 'inferred' };

type Row = {
  key: string;
  label: string;
  before?: string;
  after: string;
  source?: 'user' | 'inferred';
};

/** Format a model-supplied YYYY-MM-DD string; fall back to the raw value on parse failure. */
function fmtDate(value: string): string {
  const parsed = parseCalendarDate(value);
  return parsed ? formatCalendarDate(asCalendarDate(parsed)) : value;
}

function asSnapshotRecord(v: Prisma.JsonValue | null): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

/** Build the ordered diff rows for one proposal payload against its before-snapshot. */
function buildRows(payload: ProposalPayload, beforeSnapshot: Prisma.JsonValue | null): Row[] {
  const before = asSnapshotRecord(beforeSnapshot);
  const rows: Row[] = [];

  const push = (
    key: string,
    label: string,
    field: ProvenancedValue | undefined,
    isDate = false,
  ) => {
    if (!field) return;
    const rawBefore = before[key];
    const beforeStr =
      rawBefore === undefined || rawBefore === null
        ? undefined
        : isDate
          ? fmtDate(String(rawBefore))
          : String(rawBefore);
    rows.push({
      key,
      label,
      before: beforeStr,
      after: isDate ? fmtDate(field.value) : field.value,
      source: field.source,
    });
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
      push('purchaseDate', 'Purchase date', payload.purchaseDate, true);
      break;
    case 'UPDATE_ITEM':
      push('name', 'Name', payload.name);
      push('manufacturer', 'Manufacturer', payload.manufacturer);
      push('model', 'Model', payload.model);
      push('serialNumber', 'Serial number', payload.serialNumber);
      push('location', 'Location', payload.location);
      push('notes', 'Notes', payload.notes);
      push('purchaseDate', 'Purchase date', payload.purchaseDate, true);
      break;
    case 'UPDATE_SYSTEM':
      push('name', 'Name', payload.name);
      push('kindLabel', 'Kind', payload.kindLabel);
      push('location', 'Location', payload.location);
      push('notes', 'Notes', payload.notes);
      push('installDate', 'Install date', payload.installDate, true);
      break;
    case 'CREATE_SERVICE_RECORD':
      push('summary', 'Summary', payload.summary);
      push('performedOn', 'Performed on', payload.performedOn, true);
      push('notes', 'Notes', payload.notes);
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

  const rows = buildRows(proposal.payload, proposal.beforeSnapshot);
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
