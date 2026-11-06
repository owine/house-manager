import type { Metadata } from 'next';
import { FormPageShell } from '@/app/(app)/_components/FormPageShell';

export const metadata: Metadata = { title: 'new item' };

import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { ItemForm } from '@/components/items/ItemForm';
import { requireUser } from '@/lib/auth-guard';
import { createItem } from '@/lib/items/actions';
import { listAllCategories } from '@/lib/items/queries';
import { listSystemsForPicker } from '@/lib/systems/queries';

export default async function NewItemPage() {
  await requireUser();
  const [categories, systems] = await Promise.all([listAllCategories(), listSystemsForPicker()]);
  return (
    <FormPageShell header={<PageHeader title="new item" />}>
      <ItemForm
        categories={categories}
        systems={systems}
        action={createItem}
        submitLabel="Create item"
      />
    </FormPageShell>
  );
}
