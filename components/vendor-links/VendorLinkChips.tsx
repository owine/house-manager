'use client';

import type { VendorRole } from '@prisma/client';
import { Pencil, X } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { formatCalendarDate } from '@/lib/format/date';

export interface VendorLinkRow {
  id: string;
  vendorId: string | null;
  vendorName: string | null;
  freeformName: string | null;
  role: VendorRole;
  notes: string | null;
  serviceContract: boolean;
  contractEndsOn: Date | null;
}

export interface VendorLinkChipsProps {
  links: VendorLinkRow[];
  /** Optional callback fired when the user clicks edit on a chip. Hides the edit affordance if absent. */
  onEdit?: (id: string) => void;
  /** Optional callback fired when the user clicks delete on a chip. Hides the delete affordance if absent. */
  onDelete?: (id: string) => void;
  /** When true (default), vendor-linked chips render the vendor name as a link to /vendors/<id>. */
  linkVendorPages?: boolean;
}

function chipLabel(link: VendorLinkRow): string {
  if (link.vendorId) return link.vendorName ?? 'Vendor';
  return link.freeformName ?? '';
}

export function VendorLinkChips({
  links,
  onEdit,
  onDelete,
  linkVendorPages = true,
}: VendorLinkChipsProps) {
  if (links.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="vendor-link-chips-empty">
        No vendor links.
      </p>
    );
  }

  return (
    <TooltipProvider>
      <ul className="flex flex-wrap gap-1.5" data-testid="vendor-link-chips">
        {links.map((link) => {
          const label = chipLabel(link);
          const showVendorLink = linkVendorPages && link.vendorId;
          const hasNotes = Boolean(link.notes && link.notes.length > 0);

          const labelNode = showVendorLink ? (
            <Link
              href={`/vendors/${link.vendorId}`}
              className="underline-offset-2 hover:underline"
              data-testid={`vendor-link-chip-link-${link.id}`}
            >
              {label}
            </Link>
          ) : (
            <span data-testid={`vendor-link-chip-text-${link.id}`}>{label}</span>
          );

          const contractBadge = link.serviceContract ? (
            <Badge
              variant="outline"
              className="px-1 py-0 text-[10px]"
              data-testid={`vendor-link-chip-contract-${link.id}`}
            >
              {link.contractEndsOn
                ? `Contract → ${formatCalendarDate(link.contractEndsOn)}`
                : 'Contract'}
            </Badge>
          ) : null;

          const inner = (
            <Badge
              variant="secondary"
              className="gap-1.5 pr-1"
              data-testid={`vendor-link-chip-${link.id}`}
            >
              <span className="rounded-sm bg-foreground/10 px-1 text-[10px] font-semibold tracking-wide uppercase">
                {link.role}
              </span>
              {labelNode}
              {contractBadge}
              {onEdit && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Edit vendor link ${label}`}
                  onClick={() => onEdit(link.id)}
                  className="size-4 rounded-sm hover:bg-foreground/10"
                  data-testid={`vendor-link-chip-edit-${link.id}`}
                >
                  <Pencil className="size-3" />
                </Button>
              )}
              {onDelete && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Delete vendor link ${label}`}
                  onClick={() => onDelete(link.id)}
                  className="size-4 rounded-sm hover:bg-foreground/10"
                  data-testid={`vendor-link-chip-delete-${link.id}`}
                >
                  <X className="size-3" />
                </Button>
              )}
            </Badge>
          );

          return (
            <li key={link.id} className="inline-flex">
              {hasNotes ? (
                <Tooltip>
                  <TooltipTrigger render={<span>{inner}</span>} />
                  <TooltipContent>{link.notes}</TooltipContent>
                </Tooltip>
              ) : (
                inner
              )}
            </li>
          );
        })}
      </ul>
    </TooltipProvider>
  );
}

export default VendorLinkChips;
