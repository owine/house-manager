'use client';

import { MoreVertical, PencilLine, Wrench } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

type Props = {
  vendorId: string;
};

export function VendorOverflowMenu({ vendorId }: Props) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon" aria-label="Vendor actions">
            <MoreVertical className="h-4 w-4" />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuItem render={<Link href={`/vendors/${vendorId}/edit`} />}>
          <PencilLine className="mr-2 h-4 w-4" />
          Edit
        </DropdownMenuItem>
        <DropdownMenuItem render={<Link href={`/service/new?vendorId=${vendorId}`} />}>
          <Wrench className="mr-2 h-4 w-4" />
          Log service
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
