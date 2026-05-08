'use client';

import { useTransition } from 'react';
import { toast } from 'sonner';
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

type Option = { id: string; name: string };

type Props = {
  emailId: string;
  initialVendorId: string | null;
  initialItemId: string | null;
  initialSystemId: string | null;
  vendors: Option[];
  items: Option[];
  systems: Option[];
};

const NONE = '__none__';

export function LinkPicker({
  emailId,
  initialVendorId,
  initialItemId,
  initialSystemId,
  vendors,
  items,
  systems,
}: Props) {
  const [pending, start] = useTransition();

  const submit = (patch: {
    vendorId?: string | null;
    itemId?: string | null;
    systemId?: string | null;
  }) => {
    start(async () => {
      const r = await attachIncomingEmail({ id: emailId, ...patch });
      if (!r.ok) {
        toast.error(r.formError ?? 'Failed to update link');
        return;
      }
      toast.success('Link saved');
    });
  };

  const handle = (kind: 'vendor' | 'item' | 'system') => (raw: string | null) => {
    const value = raw == null || raw === NONE ? null : raw;
    submit(
      kind === 'vendor'
        ? { vendorId: value }
        : kind === 'item'
          ? { itemId: value }
          : { systemId: value },
    );
  };

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <PickerField
        label="Vendor"
        value={initialVendorId}
        options={vendors}
        onChange={handle('vendor')}
        disabled={pending}
      />
      <PickerField
        label="Item"
        value={initialItemId}
        options={items}
        onChange={handle('item')}
        disabled={pending}
      />
      <PickerField
        label="System"
        value={initialSystemId}
        options={systems}
        onChange={handle('system')}
        disabled={pending}
      />
    </div>
  );
}

function PickerField({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string | null;
  options: Option[];
  onChange: (v: string | null) => void;
  disabled: boolean;
}) {
  const itemsForSelect = [
    { label: '— none —', value: NONE },
    ...options.map((o) => ({ label: o.name, value: o.id })),
  ];
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Select
        items={itemsForSelect}
        value={value ?? NONE}
        onValueChange={onChange}
        disabled={disabled}
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder={`— select ${label.toLowerCase()} —`} />
        </SelectTrigger>
        <SelectContent>
          {itemsForSelect.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
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
