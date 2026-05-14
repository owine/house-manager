import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { WarrantyTable } from '@/components/warranties/WarrantyTable';
import type { getItem } from '@/lib/items/queries';

type Item = NonNullable<Awaited<ReturnType<typeof getItem>>>;

type Props = { item: Item };

export function WarrantiesTab({ item }: Props) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between border-b pb-3">
        <CardTitle>Warranties</CardTitle>
        <Button
          variant="outline"
          size="sm"
          render={<Link href={`/items/${item.id}/warranties/new`} />}
        >
          + Add warranty
        </Button>
      </CardHeader>
      <CardContent className="pt-4">
        {item.warranties.length === 0 ? (
          <p className="text-sm text-muted-foreground">no warranties yet.</p>
        ) : (
          <WarrantyTable warranties={item.warranties} />
        )}
      </CardContent>
    </Card>
  );
}
