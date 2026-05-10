'use client';

import type { VendorRole } from '@prisma/client';
import { useId, useMemo, useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { parseDateInput, toDateInputValue } from '@/lib/format/date';
import type { VendorLinkInput } from '@/lib/vendor-links/schema';

export interface VendorOption {
  id: string;
  name: string;
}

const ALL_ROLES: VendorRole[] = [
  'PURCHASE',
  'INSTALLER',
  'SERVICE',
  'WARRANTY_PROVIDER',
  'MANUFACTURER',
  'OTHER',
] as VendorRole[];

export interface VendorLinkEditorProps {
  value: VendorLinkInput | null;
  onChange: (next: VendorLinkInput) => void;
  vendors: VendorOption[];
  /** Optional set of role values to restrict the role picker to. Defaults to all VendorRole values. */
  availableRoles?: VendorRole[];
  /** Optional element id to link with parent form labels. */
  id?: string;
}

type Mode = 'existing' | 'freeform';

function inferMode(value: VendorLinkInput | null): Mode {
  if (value?.freeformName) return 'freeform';
  return 'existing';
}

export function VendorLinkEditor({
  value,
  onChange,
  vendors,
  availableRoles,
  id,
}: VendorLinkEditorProps) {
  const reactId = useId();
  const baseId = id ?? `vendor-link-editor-${reactId}`;
  const roles = useMemo(
    () => (availableRoles && availableRoles.length > 0 ? availableRoles : ALL_ROLES),
    [availableRoles],
  );

  const [mode, setMode] = useState<Mode>(inferMode(value));

  const currentRole: VendorRole = (value?.role as VendorRole | undefined) ?? roles[0];
  const currentVendorId = value?.vendorId ?? '';
  const currentFreeform = value?.freeformName ?? '';
  const currentNotes = value?.notes ?? '';
  const currentServiceContract = value?.serviceContract ?? false;
  const currentContractEndsOn = value?.contractEndsOn ?? null;

  const emit = (patch: Partial<VendorLinkInput> & { mode?: Mode }) => {
    const nextMode = patch.mode ?? mode;
    const role = (patch.role as VendorRole | undefined) ?? currentRole;
    const notes = patch.notes !== undefined ? patch.notes : currentNotes ? currentNotes : null;
    const serviceContract =
      patch.serviceContract !== undefined ? patch.serviceContract : currentServiceContract;
    const contractEndsOn =
      patch.contractEndsOn !== undefined ? patch.contractEndsOn : currentContractEndsOn;

    if (nextMode === 'existing') {
      const vendorId = patch.vendorId !== undefined ? patch.vendorId : currentVendorId || null;
      onChange({
        vendorId: vendorId || null,
        freeformName: null,
        role,
        notes: notes || null,
        serviceContract,
        contractEndsOn: contractEndsOn ?? null,
      });
    } else {
      const freeformName =
        patch.freeformName !== undefined ? patch.freeformName : currentFreeform || null;
      onChange({
        vendorId: null,
        freeformName: freeformName || null,
        role,
        notes: notes || null,
        serviceContract,
        contractEndsOn: contractEndsOn ?? null,
      });
    }
  };

  const handleModeChange = (next: Mode) => {
    setMode(next);
    if (next === 'existing') {
      onChange({
        vendorId: currentVendorId || null,
        freeformName: null,
        role: currentRole,
        notes: currentNotes || null,
        serviceContract: currentServiceContract,
        contractEndsOn: currentContractEndsOn,
      });
    } else {
      onChange({
        vendorId: null,
        freeformName: currentFreeform || null,
        role: currentRole,
        notes: currentNotes || null,
        serviceContract: currentServiceContract,
        contractEndsOn: currentContractEndsOn,
      });
    }
  };

  return (
    <div id={id} className="space-y-3" data-testid="vendor-link-editor">
      <Tabs
        value={mode}
        onValueChange={(v) => handleModeChange(v as Mode)}
        data-testid="vendor-link-editor-mode"
      >
        <TabsList>
          <TabsTrigger value="existing">Pick existing vendor</TabsTrigger>
          <TabsTrigger value="freeform">Free text</TabsTrigger>
        </TabsList>
      </Tabs>

      {mode === 'existing' ? (
        <div className="space-y-1.5">
          <Label htmlFor={`${baseId}-vendor`}>Vendor</Label>
          <Select
            items={vendors.map((v) => ({ label: v.name, value: v.id }))}
            value={currentVendorId}
            onValueChange={(v) => emit({ vendorId: v })}
          >
            <SelectTrigger id={`${baseId}-vendor`} className="w-full">
              <SelectValue placeholder="— select vendor —" />
            </SelectTrigger>
            <SelectContent>
              {vendors.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {v.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor={`${baseId}-freeform`}>Vendor name</Label>
          <Input
            id={`${baseId}-freeform`}
            type="text"
            value={currentFreeform}
            onChange={(e) => emit({ freeformName: e.target.value })}
            placeholder="e.g. Local handyman"
            maxLength={120}
          />
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor={`${baseId}-role`}>Role</Label>
        <Select value={currentRole} onValueChange={(v) => emit({ role: v as VendorRole })}>
          <SelectTrigger id={`${baseId}-role`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {roles.map((r) => (
              <SelectItem key={r} value={r}>
                {r}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <label htmlFor={`${baseId}-service-contract`} className="flex items-center gap-2">
          <Checkbox
            id={`${baseId}-service-contract`}
            checked={currentServiceContract}
            onCheckedChange={(c) =>
              emit({
                serviceContract: c === true,
                contractEndsOn: c === true ? currentContractEndsOn : null,
              })
            }
          />
          <span>Maintenance agreement</span>
        </label>
        {currentServiceContract && (
          <div className="ml-6 space-y-1.5">
            <Label htmlFor={`${baseId}-contract-ends`}>Contract ends</Label>
            <Input
              id={`${baseId}-contract-ends`}
              type="date"
              className="w-40"
              value={toDateInputValue(currentContractEndsOn)}
              onChange={(e) => emit({ contractEndsOn: parseDateInput(e.target.value) })}
            />
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${baseId}-notes`}>Notes</Label>
        <Textarea
          id={`${baseId}-notes`}
          rows={3}
          value={currentNotes}
          onChange={(e) => emit({ notes: e.target.value })}
          placeholder="Optional notes"
        />
      </div>
    </div>
  );
}
