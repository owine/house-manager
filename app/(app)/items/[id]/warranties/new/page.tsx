import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { WarrantyForm } from '@/components/warranties/WarrantyForm';
import { getItem, listAllActiveItemsForPicker } from '@/lib/items/queries';
import { listSystemsWithItemsForPicker } from '@/lib/systems/queries';
import { createWarranty } from '@/lib/warranties/actions';

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const item = await getItem(id);
  return { title: item ? `New warranty for ${item.name}` : 'Not found' };
}

export default async function NewWarrantyPage({ params }: { params: Params }) {
  const { id } = await params;
  const [item, availableItems, availableSystems] = await Promise.all([
    getItem(id),
    listAllActiveItemsForPicker(),
    listSystemsWithItemsForPicker(),
  ]);
  if (!item) notFound();

  return (
    <div>
      <h1>Add warranty for {item.name}</h1>
      <WarrantyForm
        availableItems={availableItems}
        availableSystems={availableSystems}
        initialTargets={[{ itemId: item.id }]}
        successRedirect={`/items/${item.id}?tab=warranties`}
        action={createWarranty}
        submitLabel="Add warranty"
      />
    </div>
  );
}
