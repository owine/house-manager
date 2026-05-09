'use client';

import { Plus } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { VendorLinkChips, type VendorLinkRow } from '@/components/vendor-links/VendorLinkChips';
import { VendorLinkEditor, type VendorOption } from '@/components/vendor-links/VendorLinkEditor';
import { addItemVendor, removeItemVendor, updateItemVendor } from '@/lib/items/actions';
import { emptyVendorLinkInput, type VendorLinkInput } from '@/lib/vendor-links/schema';

type Props = {
  itemId: string;
  links: VendorLinkRow[];
  vendors: VendorOption[];
};

export function ItemVendorsSection({ itemId, links, vendors }: Props) {
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<VendorLinkInput>(emptyVendorLinkInput());
  const [pending, startTransition] = useTransition();

  function openCreate() {
    setEditingId(null);
    setDraft(emptyVendorLinkInput());
    setOpen(true);
  }

  function openEdit(id: string) {
    const link = links.find((l) => l.id === id);
    if (!link) return;
    setEditingId(id);
    setDraft({
      vendorId: link.vendorId,
      freeformName: link.freeformName,
      role: link.role,
      notes: link.notes,
      serviceContract: link.serviceContract,
      contractEndsOn: link.contractEndsOn,
    });
    setOpen(true);
  }

  function handleDelete(id: string) {
    startTransition(async () => {
      const r = await removeItemVendor({ id });
      if (!r.ok) {
        toast.error(r.formError ?? 'Failed to remove vendor link');
        return;
      }
      toast.success('Vendor link removed');
    });
  }

  function handleSubmit() {
    startTransition(async () => {
      const result = editingId
        ? await updateItemVendor({ id: editingId, ...draft })
        : await addItemVendor({ itemId, ...draft });
      if (!result.ok) {
        toast.error(result.formError ?? 'Failed to save vendor link');
        return;
      }
      toast.success(editingId ? 'Vendor link updated' : 'Vendor link added');
      setOpen(false);
      setEditingId(null);
      setDraft(emptyVendorLinkInput());
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm">Vendors ({links.length})</CardTitle>
        <Button
          variant="outline"
          size="sm"
          onClick={openCreate}
          data-testid="item-vendors-add-trigger"
        >
          <Plus className="h-4 w-4" />
          Add vendor
        </Button>
      </CardHeader>
      <CardContent>
        <VendorLinkChips links={links} onEdit={openEdit} onDelete={handleDelete} />
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edit vendor link' : 'Add vendor link'}</DialogTitle>
          </DialogHeader>
          <VendorLinkEditor value={draft} onChange={setDraft} vendors={vendors} />
          <DialogFooter showCloseButton>
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={pending || (!draft.vendorId && !draft.freeformName) || !draft.role}
              data-testid="item-vendors-save"
            >
              {editingId ? 'Save' : 'Add'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
