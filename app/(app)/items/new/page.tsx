import { ItemForm } from '@/components/items/ItemForm';
import { createItem } from '@/lib/items/actions';
import { listAllCategories } from '@/lib/items/queries';

export default async function NewItemPage() {
  const categories = await listAllCategories();

  return (
    <div>
      <h1>New item</h1>
      <ItemForm categories={categories} action={createItem} submitLabel="Create item" />
    </div>
  );
}
