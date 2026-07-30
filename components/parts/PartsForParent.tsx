'use client';

import type { PartKind } from '@prisma/client';
import { Link2, Plus, X } from 'lucide-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { PART_KIND_LABELS } from '@/components/parts/kind-labels';
import { LinkExistingPartDialog, type PickerPart } from '@/components/parts/LinkExistingPartDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { unlinkPart } from '@/lib/parts/actions';

type ParentPartLinkRow = {
  id: string;
  location: string | null;
  quantityInstalled: number | null;
  part: {
    id: string;
    name: string;
    kind: PartKind;
    manufacturer: string | null;
    model: string | null;
    archivedAt: Date | null;
  };
};

type Props = {
  /** Exactly one of these is set. */
  itemId?: string;
  systemId?: string;
  links: ParentPartLinkRow[];
  /** Live parts across the house, for the "link existing" search. */
  pickerParts: PickerPart[];
};

export function PartsForParent({ itemId, systemId, links, pickerParts }: Props) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  // Pre-fill the parent on the create form so a part can be born on the
  // fixture it belongs to — nobody navigates to /parts/new and then hunts for
  // the furnace.
  const newHref = itemId ? `/parts/new?itemId=${itemId}` : `/parts/new?systemId=${systemId}`;

  function handleUnlink(linkId: string, name: string) {
    startTransition(async () => {
      const r = await unlinkPart({ linkId });
      if (!r.ok) {
        toast.error(r.formError ?? 'Failed to unlink part');
        return;
      }
      toast.success(`${name} unlinked`);
    });
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between border-b pb-3">
        <CardTitle className="text-sm">Parts ({links.length})</CardTitle>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" render={<Link href={newHref} />}>
            <Plus className="h-4 w-4" />
            Add part
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setLinkOpen(true)}
            data-testid="parts-link-trigger"
          >
            <Link2 className="h-4 w-4" />
            Link existing part
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pt-4">
        {links.length === 0 ? (
          <p className="text-sm text-muted-foreground">no parts linked yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Part</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Qty installed</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {links.map((link) => (
                <TableRow key={link.id} data-testid={`parts-row-${link.part.id}`}>
                  <TableCell>
                    <Link
                      href={`/parts/${link.part.id}`}
                      className="font-medium underline-offset-2 hover:underline"
                    >
                      {link.part.name}
                    </Link>
                    {link.part.archivedAt && (
                      <span className="ml-1 text-muted-foreground">(archived)</span>
                    )}
                    {(link.part.manufacturer || link.part.model) && (
                      <div className="text-xs text-muted-foreground">
                        {[link.part.manufacturer, link.part.model].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{PART_KIND_LABELS[link.part.kind]}</Badge>
                  </TableCell>
                  <TableCell>
                    {link.location ?? <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell>
                    {link.quantityInstalled ?? <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={pending}
                      onClick={() => handleUnlink(link.id, link.part.name)}
                      aria-label={`Unlink ${link.part.name}`}
                      data-testid={`parts-unlink-${link.part.id}`}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <LinkExistingPartDialog
        open={linkOpen}
        onOpenChange={setLinkOpen}
        itemId={itemId}
        systemId={systemId}
        parts={pickerParts}
        linkedPartIds={links.map((l) => l.part.id)}
      />
    </Card>
  );
}
