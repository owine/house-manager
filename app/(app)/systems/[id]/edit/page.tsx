import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { FormPageShell } from '@/app/(app)/_components/FormPageShell';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { SystemForm } from '@/components/systems/SystemForm';
import { updateSystem } from '@/lib/systems/actions';
import { getSystem } from '@/lib/systems/queries';

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const system = await getSystem(id);
  return { title: system ? `Edit ${system.name}` : 'Not found' };
}

export default async function EditSystemPage({ params }: { params: Params }) {
  const { id } = await params;
  const system = await getSystem(id);
  if (!system) notFound();

  return (
    <FormPageShell header={<PageHeader title={`edit ${system.name}`} />}>
      <SystemForm
        defaultValues={{
          id: system.id,
          name: system.name,
          kind: system.kind ?? undefined,
          location: system.location ?? undefined,
          installDate: system.installDate
            ? (system.installDate.toISOString().slice(0, 10) as unknown as Date)
            : undefined,
          installCost: system.installCost?.toNumber() ?? undefined,
          notes: system.notes ?? undefined,
        }}
        action={updateSystem}
        submitLabel="Save changes"
      />
    </FormPageShell>
  );
}
