import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DetailPageShell } from '@/app/(app)/_components/DetailPageShell';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { PART_KIND_LABELS } from '@/components/parts/kind-labels';
import { PartOverflowMenu } from '@/components/parts/PartOverflowMenu';
import { Badge } from '@/components/ui/badge';
import { LocalDate } from '@/components/ui/LocalDate';
import { archivePart, restorePart } from '@/lib/parts/actions';
import { getPart } from '@/lib/parts/queries';
import { LinksTab } from './tabs/LinksTab';
import { OverviewTab } from './tabs/OverviewTab';
import { RemindersTab } from './tabs/RemindersTab';
import { ServiceTab } from './tabs/ServiceTab';

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const part = await getPart(id);
  return { title: part?.name ?? 'Not found' };
}

export default async function PartDetailPage({ params }: { params: Params }) {
  const { id } = await params;
  const part = await getPart(id);
  if (!part) notFound();

  const partId = part.id;

  async function doArchive() {
    'use server';
    await archivePart(partId);
  }

  async function doRestore() {
    'use server';
    await restorePart(partId);
  }

  return (
    <DetailPageShell
      header={
        <PageHeader
          title={part.name}
          actions={
            <div className="flex items-center gap-2">
              <Badge variant="secondary">{PART_KIND_LABELS[part.kind]}</Badge>
              {part.archivedAt && (
                <Badge variant="destructive">
                  Archived <LocalDate iso={part.archivedAt.toISOString()} />
                </Badge>
              )}
              <PartOverflowMenu
                partId={part.id}
                isArchived={part.archivedAt !== null}
                onArchive={doArchive}
                onRestore={doRestore}
              />
            </div>
          }
        />
      }
      tabs={[
        { value: 'overview', label: 'Overview', content: <OverviewTab part={part} /> },
        { value: 'links', label: 'Links', content: <LinksTab part={part} /> },
        { value: 'reminders', label: 'Reminders', content: <RemindersTab part={part} /> },
        { value: 'service', label: 'Service', content: <ServiceTab part={part} /> },
      ]}
    />
  );
}
