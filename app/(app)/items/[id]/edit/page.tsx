import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { FormPageShell } from '@/app/(app)/_components/FormPageShell';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { ItemForm } from '@/components/items/ItemForm';
import { updateItem } from '@/lib/items/actions';
import { getItem, listAllCategories } from '@/lib/items/queries';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const item = await getItem(id);
  return { title: item ? `Edit ${item.name}` : 'Not found' };
}

export default async function EditItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [item, categories] = await Promise.all([getItem(id), listAllCategories()]);
  if (!item) notFound();
  return (
    <FormPageShell header={<PageHeader title={`Edit ${item.name}`} />}>
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
    </FormPageShell>
  );
}
