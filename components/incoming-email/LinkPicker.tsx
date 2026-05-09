'use client';

import { ChevronDown } from 'lucide-react';
import { useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  type AvailableItem,
  type AvailableSystem,
  TargetsPicker,
} from '@/components/targets/TargetsPicker';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  archiveIncomingEmail,
  attachIncomingEmail,
  createServiceRecordFromEmail,
  reclassifyIncomingEmail,
  unarchiveIncomingEmail,
} from '@/lib/incoming-email/actions';
import type { TargetInput } from '@/lib/targets/schema';

type VendorOption = { id: string; name: string };

type Props = {
  emailId: string;
  initialVendorId: string | null;
  initialTargets: TargetInput[];
  vendors: VendorOption[];
  items: AvailableItem[];
  systems: AvailableSystem[];
};

const NONE = '__none__';

export function LinkPicker({
  emailId,
  initialVendorId,
  initialTargets,
  vendors,
  items,
  systems,
}: Props) {
  const [pending, start] = useTransition();
  const [vendorId, setVendorId] = useState<string | null>(initialVendorId);
  const [targets, setTargets] = useState<TargetInput[]>(initialTargets);

  // Auto-save: vendor changes commit immediately; target-set changes commit
  // when the popover closes. The action's `targets` field is omitted when we
  // only changed vendor (and vice versa) so the server only mutates what
  // actually changed in the round-trip.
  const submit = (patch: { vendorId?: string | null; targets?: TargetInput[] }) => {
    start(async () => {
      const r = await attachIncomingEmail({ id: emailId, ...patch });
      if (!r.ok) {
        toast.error(r.formError ?? 'Failed to update link');
        return;
      }
      toast.success('Link saved');
    });
  };

  const onVendorChange = (raw: string | null) => {
    const next = raw == null || raw === NONE ? null : raw;
    setVendorId(next);
    if (next !== vendorId) submit({ vendorId: next });
  };

  // Capture targets-at-popover-open so the close-side commit can detect a
  // no-op (popover opened, nothing toggled) and skip the round-trip.
  const onTargetsCommit = (next: TargetInput[]) => {
    submit({ targets: next });
  };

  const vendorItems = [
    { label: '— none —', value: NONE },
    ...vendors.map((v) => ({ label: v.name, value: v.id })),
  ];

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="link-picker-vendor">Vendor</Label>
        <Select
          items={vendorItems}
          value={vendorId ?? NONE}
          onValueChange={onVendorChange}
          disabled={pending}
        >
          <SelectTrigger id="link-picker-vendor" className="w-full sm:w-1/2">
            <SelectValue placeholder="— select vendor —" />
          </SelectTrigger>
          <SelectContent>
            {vendorItems.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label>Items &amp; systems</Label>
        <TargetsPickerDropdown
          value={targets}
          onChange={setTargets}
          onCommit={onTargetsCommit}
          availableItems={items}
          availableSystems={systems}
        />
      </div>
    </div>
  );
}

/**
 * Compact wrapper around the shared <TargetsPicker> for the inbox detail page,
 * which doesn't have the screen real estate that service-record / warranty /
 * reminder forms do. The trigger button shows a one-line summary of selected
 * items + systems; the picker itself opens in a popover anchored to the
 * trigger. The shared TargetsPicker stays untouched — other call sites still
 * get the inline experience.
 */
function targetsEqual(a: TargetInput[], b: TargetInput[]): boolean {
  if (a.length !== b.length) return false;
  // Order-insensitive equality on (itemId|systemId) keys. Replace-set semantics
  // on the server side don't care about order, so neither should we.
  const key = (t: TargetInput) => `${t.itemId ?? ''}::${t.systemId ?? ''}`;
  const aSet = new Set(a.map(key));
  return b.every((t) => aSet.has(key(t)));
}

function TargetsPickerDropdown({
  value,
  onChange,
  onCommit,
  availableItems,
  availableSystems,
}: {
  value: TargetInput[];
  onChange: (next: TargetInput[]) => void;
  /** Called when the popover closes IF the value actually changed. */
  onCommit: (next: TargetInput[]) => void;
  availableItems: AvailableItem[];
  availableSystems: AvailableSystem[];
}) {
  const [open, setOpen] = useState(false);
  // Snapshot of `value` at the moment the popover opened. We compare against
  // this on close to decide whether to fire onCommit (skip if no-op).
  const [snapshot, setSnapshot] = useState<TargetInput[]>(value);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setSnapshot(value);
    } else if (!targetsEqual(snapshot, value)) {
      onCommit(value);
    }
  };
  const summary = useMemo(() => {
    const itemNames = value
      .filter((t) => t.itemId)
      .map((t) => availableItems.find((i) => i.id === t.itemId)?.name)
      .filter((n): n is string => Boolean(n));
    const systemNames = value
      .filter((t) => t.systemId)
      .map((t) => availableSystems.find((s) => s.id === t.systemId)?.name)
      .filter((n): n is string => Boolean(n));
    const all = [...itemNames, ...systemNames];
    if (all.length === 0) return '— select items / systems —';
    if (all.length <= 2) return all.join(', ');
    return `${all.slice(0, 2).join(', ')} +${all.length - 2} more`;
  }, [value, availableItems, availableSystems]);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            className="w-full justify-between text-left font-normal sm:w-1/2"
          >
            <span className="truncate">{summary}</span>
            <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        }
      />
      <PopoverContent className="w-[min(36rem,calc(100vw-2rem))] max-h-[70vh] overflow-y-auto p-0">
        <div className="p-3">
          <TargetsPicker
            value={value}
            onChange={onChange}
            availableItems={availableItems}
            availableSystems={availableSystems}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Action buttons separated so the detail page can place them where it likes. */
export function InboxActionButtons({
  emailId,
  isArchived,
  canCreateServiceRecord,
  canReclassify,
  createdServiceRecordId,
}: {
  emailId: string;
  isArchived: boolean;
  canCreateServiceRecord: boolean;
  /**
   * True only for UNTRIAGED + AUTO_LINKED rows that aren't archived. The
   * worker's state guard means a reclassify on LINKED/ARCHIVED rows would
   * only refresh kind+vendor metadata (silently leaving targets alone),
   * which is more confusing than helpful — hide the button instead.
   */
  canReclassify: boolean;
  createdServiceRecordId: string | null;
}) {
  const [pending, start] = useTransition();

  const onArchive = () =>
    start(async () => {
      const action = isArchived ? unarchiveIncomingEmail : archiveIncomingEmail;
      const r = await action({ id: emailId });
      if (!r.ok) toast.error(r.formError ?? 'Failed');
      else toast.success(isArchived ? 'Unarchived' : 'Archived');
    });

  const onCreateServiceRecord = () =>
    start(async () => {
      const r = await createServiceRecordFromEmail({ id: emailId });
      if (!r.ok) toast.error(r.formError ?? 'Failed to create service record');
      else toast.success('Service record created');
    });

  const onReclassify = () =>
    start(async () => {
      const r = await reclassifyIncomingEmail({ id: emailId });
      if (!r.ok) toast.error(r.formError ?? 'Failed to reclassify');
      else toast.success('Reclassify queued — refresh in a moment');
    });

  return (
    <div className="flex flex-wrap gap-2">
      {createdServiceRecordId ? (
        <Button
          variant="outline"
          render={<a href={`/service/${createdServiceRecordId}`}>View service record</a>}
        />
      ) : (
        <Button onClick={onCreateServiceRecord} disabled={pending || !canCreateServiceRecord}>
          Create service record
        </Button>
      )}
      {canReclassify && (
        <Button variant="outline" onClick={onReclassify} disabled={pending}>
          Reclassify
        </Button>
      )}
      <Button variant="outline" onClick={onArchive} disabled={pending}>
        {isArchived ? 'Unarchive' : 'Archive'}
      </Button>
    </div>
  );
}
