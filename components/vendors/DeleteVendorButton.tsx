'use client';

import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  convertVendorLinksToFreeform,
  deleteVendorAndLinks,
  tryDeleteVendor,
} from '@/lib/vendors/actions';
import { DeleteVendorDialog } from './DeleteVendorDialog';

type Props = {
  vendorId: string;
  vendorName: string;
  itemCount: number;
  systemCount: number;
};

/**
 * Trigger + dialog wrapper for the mediated vendor delete flow. The page
 * passes link counts (already in scope) so the dialog can decide which
 * resolution UI to show without an extra round-trip.
 */
export function DeleteVendorButton({ vendorId, vendorName, itemCount, systemCount }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        data-testid="delete-vendor-trigger"
      >
        <Trash2 className="h-4 w-4" />
        Delete vendor
      </Button>
      <DeleteVendorDialog
        vendorId={vendorId}
        vendorName={vendorName}
        itemCount={itemCount}
        systemCount={systemCount}
        open={open}
        onOpenChange={setOpen}
        tryDeleteAction={tryDeleteVendor}
        convertAction={convertVendorLinksToFreeform}
        deleteWithLinksAction={deleteVendorAndLinks}
      />
    </>
  );
}

export default DeleteVendorButton;
