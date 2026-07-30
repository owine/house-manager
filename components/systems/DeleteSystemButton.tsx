'use client';

import { Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { DeleteSystemPartsDialog } from '@/components/systems/DeleteSystemPartsDialog';
import { Button } from '@/components/ui/button';
import type { SystemPartSummary } from '@/lib/systems/actions';

type Props = {
  systemName: string;
  /** Injected by the server page, per the action-injection convention. */
  onTryDelete: () => Promise<
    | { ok: true }
    | { ok: false; hasParts: true; parts: SystemPartSummary[] }
    | { ok: false; formError?: string }
  >;
  onDeleteWithParts: (input: {
    archivePartIds: string[];
    keepPartIds: string[];
  }) => Promise<
    | { ok: true; archivedCount: number; keptCount: number }
    | { ok: false; hasParts: true; parts: SystemPartSummary[] }
    | { ok: false; formError?: string }
  >;
};

/**
 * The only entry point for deleting a system. A system with no parts deletes
 * straight away; one with parts opens the archive-or-keep prompt.
 */
export function DeleteSystemButton({ systemName, onTryDelete, onDeleteWithParts }: Props) {
  const router = useRouter();
  const [parts, setParts] = useState<SystemPartSummary[] | null>(null);
  const [pending, startTransition] = useTransition();

  function handleClick() {
    startTransition(async () => {
      const r = await onTryDelete();
      if (r.ok) {
        toast.success('System deleted');
        router.push('/systems');
        return;
      }
      if ('hasParts' in r) {
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
        onClick={handleClick}
        disabled={pending}
        data-testid="system-delete-trigger"
      >
        <Trash2 className="h-4 w-4" />
        Delete
      </Button>
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
            }
            return r;
          }}
        />
      )}
    </>
  );
}
