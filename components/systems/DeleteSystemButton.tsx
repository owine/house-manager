'use client';

import { Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { DeleteSystemPartsDialog } from '@/components/systems/DeleteSystemPartsDialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import type { SystemDependentSummary, SystemPartSummary } from '@/lib/systems/actions';

type Props = {
  systemName: string;
  /** Injected by the server page, per the action-injection convention. */
  onTryDelete: () => Promise<
    | { ok: true }
    | { ok: false; hasDependents: true; dependents: SystemDependentSummary[] }
    | { ok: false; hasParts: true; parts: SystemPartSummary[] }
    | { ok: false; formError?: string }
  >;
  onDeleteWithParts: (input: {
    archivePartIds: string[];
    keepPartIds: string[];
  }) => Promise<
    | { ok: true; archivedCount: number; keptCount: number }
    | { ok: false; hasDependents: true; dependents: SystemDependentSummary[] }
    | { ok: false; hasParts: true; parts: SystemPartSummary[] }
    | { ok: false; formError?: string }
  >;
};

const DEPENDENT_HREF: Record<SystemDependentSummary['kind'], (id: string) => string> = {
  reminder: (id) => `/reminders/${id}`,
  warranty: (id) => `/warranties/${id}`,
  serviceRecord: (id) => `/service/${id}`,
};

const DEPENDENT_KIND_LABEL: Record<SystemDependentSummary['kind'], string> = {
  reminder: 'Reminder',
  warranty: 'Warranty',
  serviceRecord: 'Service record',
};

/**
 * The only entry point for deleting a system. Every delete is confirmed first.
 * The server then either deletes, refuses with the records that would be left
 * with no target (listed here, each linked so the user can retarget or delete
 * it), or hands over to the archive-or-keep parts prompt.
 */
export function DeleteSystemButton({ systemName, onTryDelete, onDeleteWithParts }: Props) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [dependents, setDependents] = useState<SystemDependentSummary[]>([]);
  const [parts, setParts] = useState<SystemPartSummary[] | null>(null);
  const [pending, startTransition] = useTransition();

  const blocked = dependents.length > 0;

  function openConfirm() {
    setDependents([]);
    setConfirmOpen(true);
  }

  function handleConfirm() {
    startTransition(async () => {
      const r = await onTryDelete();
      if (r.ok) {
        setConfirmOpen(false);
        toast.success('System deleted');
        router.push('/systems');
        return;
      }
      if ('hasDependents' in r) {
        setDependents(r.dependents);
        return;
      }
      if ('hasParts' in r) {
        setConfirmOpen(false);
        setParts(r.parts);
        return;
      }
      toast.error(r.formError ?? 'Failed to delete system');
    });
  }

  return (
    <>
      <Button
        variant="destructive"
        onClick={openConfirm}
        disabled={pending}
        data-testid="system-delete-trigger"
      >
        <Trash2 className="h-4 w-4" />
        Delete
      </Button>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent data-testid="delete-system-alert">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {blocked ? `${systemName} can't be deleted yet` : `Permanently delete ${systemName}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {blocked
                ? 'These records point only at this system. Deleting it would leave them tracking nothing — give each another item or system, or delete it, first. Or archive the system instead.'
                : 'Its links from reminders, warranties and service records are removed. This cannot be undone.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {blocked && (
            <ul className="max-h-72 space-y-1 overflow-y-auto" data-testid="delete-system-blockers">
              {dependents.map((d) => (
                <li key={`${d.kind}-${d.id}`} className="rounded-md border p-2 text-sm">
                  {/* Labels are user-supplied: text, never markup. */}
                  <Link
                    href={DEPENDENT_HREF[d.kind](d.id)}
                    className="font-medium underline-offset-2 hover:underline"
                  >
                    {d.label}
                  </Link>
                  <span className="block text-xs text-muted-foreground">
                    {DEPENDENT_KIND_LABEL[d.kind]}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>{blocked ? 'Close' : 'Cancel'}</AlertDialogCancel>
            {!blocked && (
              <AlertDialogAction
                variant="destructive"
                onClick={handleConfirm}
                disabled={pending}
                data-testid="delete-system-alert-confirm"
              >
                Delete system
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {parts && (
        <DeleteSystemPartsDialog
          open
          onOpenChange={(next) => {
            if (!next) setParts(null);
          }}
          systemName={systemName}
          parts={parts}
          onConfirm={async (input) => {
            const r = await onDeleteWithParts(input);
            if (r.ok) {
              setParts(null);
              router.push('/systems');
            } else if ('hasDependents' in r) {
              // A sole-target record appeared after the prompt: swap back to
              // the blocking list.
              setParts(null);
              setDependents(r.dependents);
              setConfirmOpen(true);
            }
            return r;
          }}
        />
      )}
    </>
  );
}
