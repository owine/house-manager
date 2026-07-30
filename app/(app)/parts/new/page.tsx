import type { Metadata } from 'next';
import { FormPageShell } from '@/app/(app)/_components/FormPageShell';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { PartForm } from '@/components/parts/PartForm';
import { createPart, linkPartToParent } from '@/lib/parts/actions';

export const metadata: Metadata = { title: 'new part' };

type SearchParams = Promise<{ itemId?: string; systemId?: string }>;

export default async function NewPartPage({ searchParams }: { searchParams: SearchParams }) {
  const { itemId, systemId } = await searchParams;
  // Exactly one parent, matching the XOR on part_links. A URL carrying both is
  // nonsense; prefer the item and ignore the rest rather than half-linking.
  const parentItemId = itemId || undefined;
  const parentSystemId = parentItemId ? undefined : systemId || undefined;
  const hasParent = Boolean(parentItemId || parentSystemId);

  async function createAndLink(input: unknown) {
    'use server';
    const created = await createPart(input);
    if (!created.ok) return created;
    // The link is a side effect of a mutation the user already committed —
    // surfacing a failure here would strand a part they can still see.
    await linkPartToParent({
      partId: created.data.id,
      itemId: parentItemId,
      systemId: parentSystemId,
    });
    return created;
  }

  return (
    <FormPageShell header={<PageHeader title="new part" />}>
      <PartForm action={hasParent ? createAndLink : createPart} submitLabel="Create part" />
    </FormPageShell>
  );
}
