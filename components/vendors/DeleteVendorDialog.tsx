'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type {
  ConvertVendorLinksResult,
  DeleteVendorAndLinksResult,
  TryDeleteVendorResult,
} from '@/lib/vendors/actions';

export type TryDeleteVendorAction = (vendorId: string) => Promise<TryDeleteVendorResult>;
export type ConvertVendorLinksAction = (vendorId: string) => Promise<ConvertVendorLinksResult>;
export type DeleteVendorAndLinksAction = (vendorId: string) => Promise<DeleteVendorAndLinksResult>;

export type DeleteVendorDialogProps = {
  vendorId: string;
  vendorName: string;
  itemCount: number;
  systemCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Server actions injected so jsdom tests can stub them. */
  tryDeleteAction: TryDeleteVendorAction;
  convertAction: ConvertVendorLinksAction;
  deleteWithLinksAction: DeleteVendorAndLinksAction;
  /** Override navigation for tests. */
  onSuccess?: () => void;
};

export function DeleteVendorDialog({
  vendorId,
  vendorName,
  itemCount,
  systemCount,
  open,
  onOpenChange,
  tryDeleteAction,
  convertAction,
  deleteWithLinksAction,
  onSuccess,
}: DeleteVendorDialogProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteWithLinks, setConfirmDeleteWithLinks] = useState(false);
  const [pending, startTransition] = useTransition();

  // Reset transient confirm/error state every time the dialog reopens.
  useEffect(() => {
    if (open) {
      setError(null);
      setConfirmDeleteWithLinks(false);
    }
  }, [open]);

  const hasLinks = itemCount > 0 || systemCount > 0;

  function handleSuccess() {
    onOpenChange(false);
    if (onSuccess) {
      onSuccess();
    } else {
      router.push('/vendors');
      router.refresh();
    }
  }

  function onPlainDelete() {
    setError(null);
    startTransition(async () => {
      const r = await tryDeleteAction(vendorId);
      if (r.ok) {
        handleSuccess();
        return;
      }
      if ('hasLinks' in r) {
        // Race: links appeared between page render and click. Surface the error.
        setError(
          `Vendor now has ${r.itemCount} linked items and ${r.systemCount} linked systems — reload to choose a resolution.`,
        );
        return;
      }
      setError(r.formError ?? 'Could not delete vendor');
    });
  }

  function onConvert() {
    setError(null);
    startTransition(async () => {
      const r = await convertAction(vendorId);
      if (r.ok) {
        handleSuccess();
        return;
      }
      if ('error' in r && r.error === 'not_found') {
        setError('Vendor no longer exists.');
        return;
      }
      setError(('formError' in r && r.formError) || 'Could not convert vendor links');
    });
  }

  function onDeleteWithLinks() {
    if (!confirmDeleteWithLinks) {
      setConfirmDeleteWithLinks(true);
      return;
    }
    setError(null);
    startTransition(async () => {
      const r = await deleteWithLinksAction(vendorId);
      if (r.ok) {
        handleSuccess();
        return;
      }
      setError(r.formError ?? 'Could not delete vendor and links');
    });
  }

  const linkSummary = (() => {
    const parts: string[] = [];
    if (itemCount > 0) parts.push(`${itemCount} item${itemCount === 1 ? '' : 's'}`);
    if (systemCount > 0) parts.push(`${systemCount} system${systemCount === 1 ? '' : 's'}`);
    return parts.join(' and ');
  })();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete vendor: {vendorName}</DialogTitle>
        </DialogHeader>

        {hasLinks ? (
          <div className="flex flex-col gap-3" data-testid="delete-vendor-has-links">
            <p className="text-sm">
              {linkSummary} {itemCount + systemCount === 1 ? 'is' : 'are'} linked to this vendor.
              Choose how to resolve them:
            </p>
            <ul className="flex list-disc flex-col gap-2 pl-5 text-sm text-muted-foreground">
              <li>
                <strong className="text-foreground">Convert to free-text</strong>: keep the links,
                preserve the vendor name as plain text on each link, and remove the vendor record.
              </li>
              <li>
                <strong className="text-foreground">Delete vendor and remove all links</strong>:
                drop every linked row along with the vendor. This is irreversible.
              </li>
            </ul>
            {confirmDeleteWithLinks && (
              <p
                className="text-sm font-medium text-destructive"
                role="alert"
                data-testid="delete-vendor-confirm-cascade"
              >
                Click "Delete vendor and remove all links" again to confirm.
              </p>
            )}
          </div>
        ) : (
          <div data-testid="delete-vendor-no-links">
            <p className="text-sm">
              Are you sure you want to delete <strong>{vendorName}</strong>? This cannot be undone.
            </p>
          </div>
        )}

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          {hasLinks ? (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={onConvert}
                disabled={pending}
                data-testid="delete-vendor-convert"
              >
                Convert to free-text
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={onDeleteWithLinks}
                disabled={pending}
                data-testid="delete-vendor-cascade"
              >
                {confirmDeleteWithLinks ? 'Confirm delete' : 'Delete vendor and remove all links'}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="destructive"
              onClick={onPlainDelete}
              disabled={pending}
              data-testid="delete-vendor-confirm"
            >
              Delete vendor
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default DeleteVendorDialog;
