import { FormPageShell } from '@/app/(app)/_components/FormPageShell';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { ItemForm } from '@/components/items/ItemForm';
import { createItem } from '@/lib/items/actions';
import { listAllCategories } from '@/lib/items/queries';

export default async function NewItemPage() {
  const categories = await listAllCategories();
  return (
    <FormPageShell header={<PageHeader title="New item" />}>
      <ItemForm categories={categories} action={createItem} submitLabel="Create item" />
    </FormPageShell>
  );
}
