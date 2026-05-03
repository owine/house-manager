'use client';

import { Archive, ArchiveRestore, MoreVertical, PencilLine } from 'lucide-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { setIncludeInSuggestions as setIncludeInSuggestionsAction } from '@/lib/items/actions';

type Props = {
  itemId: string;
  isArchived: boolean;
  initialIncludeInSuggestions: boolean;
  onArchive: () => Promise<void>;
  onRestore: () => Promise<void>;
};

export function ItemOverflowMenu({
  itemId,
  isArchived,
  initialIncludeInSuggestions,
  onArchive,
  onRestore,
}: Props) {
  const [includeInSuggestions, setIncludeInSuggestions] = useState(initialIncludeInSuggestions);
  const [pending, startTransition] = useTransition();

  function toggleSuggestions(next: boolean) {
    setIncludeInSuggestions(next); // optimistic
    startTransition(async () => {
      const r = await setIncludeInSuggestionsAction({ itemId, value: next });
      if (!r.ok) {
        setIncludeInSuggestions(!next); // revert
        toast.error(r.formError ?? 'Failed to update suggestion preference');
        return;
      }
      toast.success(next ? 'Item included in AI suggestions' : 'Item excluded from AI suggestions');
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger>
        <Button variant="ghost" size="icon" aria-label="Item actions">
          <MoreVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuCheckboxItem
          checked={includeInSuggestions}
          onCheckedChange={(c) => toggleSuggestions(c === true)}
          disabled={pending}
        >
          Include in AI suggestions
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link href={`/items/${itemId}/edit`} />}>
          <PencilLine className="mr-2 h-4 w-4" />
          Edit
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {isArchived ? (
          <DropdownMenuItem onClick={() => void onRestore()}>
            <ArchiveRestore className="mr-2 h-4 w-4" />
            Restore
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem variant="destructive" onClick={() => void onArchive()}>
            <Archive className="mr-2 h-4 w-4" />
            Archive
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
