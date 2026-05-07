'use client';

import type { VendorRole } from '@prisma/client';
import { useId, useMemo, useState } from 'react';
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

  const emit = (patch: Partial<VendorLinkInput> & { mode?: Mode }) => {
    const nextMode = patch.mode ?? mode;
    const role = (patch.role as VendorRole | undefined) ?? currentRole;
    const notes = patch.notes !== undefined ? patch.notes : currentNotes ? currentNotes : null;

    if (nextMode === 'existing') {
      const vendorId = patch.vendorId !== undefined ? patch.vendorId : currentVendorId || null;
      onChange({
        vendorId: vendorId || null,
        freeformName: null,
        role,
        notes: notes || null,
      });
    } else {
      const freeformName =
        patch.freeformName !== undefined ? patch.freeformName : currentFreeform || null;
      onChange({
        vendorId: null,
        freeformName: freeformName || null,
        role,
        notes: notes || null,
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
      });
    } else {
      onChange({
        vendorId: null,
        freeformName: currentFreeform || null,
        role: currentRole,
        notes: currentNotes || null,
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
          <Select value={currentVendorId} onValueChange={(v) => emit({ vendorId: v })}>
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

export default VendorLinkEditor;
