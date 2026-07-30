import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { FormPageShell } from '@/app/(app)/_components/FormPageShell';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { PartForm } from '@/components/parts/PartForm';
import { updatePart } from '@/lib/parts/actions';
import { getPart } from '@/lib/parts/queries';
import type { CreatePartInput } from '@/lib/parts/schema';

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const part = await getPart(id);
  return { title: part ? `Edit ${part.name}` : 'Not found' };
}

export default async function EditPartPage({ params }: { params: Params }) {
  const { id } = await params;
  const part = await getPart(id);
  if (!part) notFound();

  return (
    <FormPageShell header={<PageHeader title={`edit ${part.name}`} />}>
      <PartForm
        defaultValues={{
          id: part.id,
          name: part.name,
          kind: part.kind,
          location: part.location ?? undefined,
          manufacturer: part.manufacturer ?? undefined,
          model: part.model ?? undefined,
          sku: part.sku ?? undefined,
          typicalCost: part.typicalCost?.toNumber() ?? undefined,
          packQuantity: part.packQuantity ?? undefined,
          // `purchaseLinks` is a Json column; the shape is enforced on write by
          // `createPartSchema`, so a stored blob is trusted here.
          purchaseLinks: (part.purchaseLinks ?? []) as CreatePartInput['purchaseLinks'],
          metadata: (part.metadata ?? {}) as Record<string, unknown>,
          notes: part.notes ?? undefined,
        }}
        action={updatePart}
        submitLabel="Save changes"
      />
    </FormPageShell>
  );
}
