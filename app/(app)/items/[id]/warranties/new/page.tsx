import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { WarrantyForm } from '@/components/warranties/WarrantyForm';
import { getItem } from '@/lib/items/queries';
import { createWarranty } from '@/lib/warranties/actions';

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const item = await getItem(id);
  return { title: item ? `New warranty for ${item.name}` : 'Not found' };
}

export default async function NewWarrantyPage({ params }: { params: Params }) {
  const { id } = await params;
  const item = await getItem(id);
  if (!item) notFound();

  return (
    <div>
      <h1>Add warranty for {item.name}</h1>
      <WarrantyForm itemId={item.id} action={createWarranty} submitLabel="Add warranty" />
    </div>
  );
}
