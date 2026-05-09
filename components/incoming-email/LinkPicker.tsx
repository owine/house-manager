'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  type AvailableItem,
  type AvailableSystem,
  TargetsPicker,
} from '@/components/targets/TargetsPicker';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { attachIncomingEmail } from '@/lib/incoming-email/actions';
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
  const [dirty, setDirty] = useState(false);

  const submit = () => {
    start(async () => {
      const r = await attachIncomingEmail({ id: emailId, vendorId, targets });
      if (!r.ok) {
        toast.error(r.formError ?? 'Failed to update link');
        return;
      }
      toast.success('Link saved');
      setDirty(false);
    });
  };

  const onVendorChange = (raw: string | null) => {
    setVendorId(raw == null || raw === NONE ? null : raw);
    setDirty(true);
  };

  const onTargetsChange = (next: TargetInput[]) => {
    setTargets(next);
    setDirty(true);
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
        <TargetsPicker
          value={targets}
          onChange={onTargetsChange}
          availableItems={items}
          availableSystems={systems}
        />
      </div>

      <div className="flex justify-end">
        <Button onClick={submit} disabled={pending || !dirty}>
          {pending ? 'Saving…' : 'Save links'}
        </Button>
      </div>
    </div>
  );
}

/** Action buttons separated so the detail page can place them where it likes. */
export function InboxActionButtons({
  emailId,
  isArchived,
  canPromote,
  promotedServiceRecordId,
}: {
  emailId: string;
  isArchived: boolean;
  canPromote: boolean;
  promotedServiceRecordId: string | null;
}) {
  const [pending, start] = useTransition();

  const onArchive = () =>
    start(async () => {
      const { archiveIncomingEmail, unarchiveIncomingEmail } = await import(
        '@/lib/incoming-email/actions'
      );
      const action = isArchived ? unarchiveIncomingEmail : archiveIncomingEmail;
      const r = await action({ id: emailId });
      if (!r.ok) toast.error(r.formError ?? 'Failed');
      else toast.success(isArchived ? 'Unarchived' : 'Archived');
    });

  const onPromote = () =>
    start(async () => {
      const { promoteToServiceRecord } = await import('@/lib/incoming-email/actions');
      const r = await promoteToServiceRecord({ id: emailId });
      if (!r.ok) toast.error(r.formError ?? 'Failed to promote');
      else toast.success('Service record drafted');
    });

  return (
    <div className="flex flex-wrap gap-2">
      {promotedServiceRecordId ? (
        <Button
          variant="outline"
          render={<a href={`/service/${promotedServiceRecordId}`}>View drafted service record</a>}
        />
      ) : (
        <Button onClick={onPromote} disabled={pending || !canPromote}>
          Promote to service record
        </Button>
      )}
      <Button variant="outline" onClick={onArchive} disabled={pending}>
        {isArchived ? 'Unarchive' : 'Archive'}
      </Button>
    </div>
  );
}
