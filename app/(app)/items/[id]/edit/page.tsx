import { notFound } from 'next/navigation';
import { ItemForm } from '@/components/items/ItemForm';
import { updateItem } from '@/lib/items/actions';
import { getItem, listAllCategories } from '@/lib/items/queries';

type Params = Promise<{ id: string }>;

export default async function EditItemPage({ params }: { params: Params }) {
  const { id } = await params;
  const [item, categories] = await Promise.all([getItem(id), listAllCategories()]);
  if (!item) notFound();

  return (
    <div>
      <h1>Edit item</h1>
      <ItemForm
        categories={categories}
        defaultValues={{
          id: item.id,
          name: item.name,
          categorySlug: item.category.slug,
          location: item.location ?? undefined,
          manufacturer: item.manufacturer ?? undefined,
          model: item.model ?? undefined,
          serialNumber: item.serialNumber ?? undefined,
          purchaseDate: item.purchaseDate?.toISOString().slice(0, 10) as unknown as
            | Date
            | undefined,
          purchasePrice: item.purchasePrice?.toNumber() ?? undefined,
          metadata: (item.metadata ?? {}) as Record<string, unknown>,
          notes: item.notes ?? undefined,
        }}
        action={updateItem}
        submitLabel="Save changes"
      />
    </div>
  );
}
