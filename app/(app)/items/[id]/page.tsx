import { notFound } from 'next/navigation';
import { ItemHeader } from '@/components/items/ItemHeader';
import { ItemMetaCard } from '@/components/items/ItemMetaCard';
import { ItemOverflowMenu } from '@/components/items/ItemOverflowMenu';
import { ItemTabs, type TabSlug } from '@/components/items/ItemTabs';
import { archiveItem, restoreItem } from '@/lib/items/actions';
import { getItem } from '@/lib/items/queries';
import { FilesTab } from './tabs/FilesTab';
import { NotesTab } from './tabs/NotesTab';
import { OverviewTab } from './tabs/OverviewTab';
import { RemindersTab } from './tabs/RemindersTab';
import { ServiceTab } from './tabs/ServiceTab';
import { WarrantiesTab } from './tabs/WarrantiesTab';

type Params = Promise<{ id: string }>;
type SearchParams = Promise<{ tab?: string }>;

const VALID_TABS = ['overview', 'warranties', 'service', 'notes', 'files', 'reminders'] as const;

function parseTab(raw: string | undefined): TabSlug {
  return (VALID_TABS as readonly string[]).includes(raw ?? '') ? (raw as TabSlug) : 'overview';
}

export default async function ItemDetailPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const tab = parseTab(sp.tab);
  const item = await getItem(id);
  if (!item) notFound();

  const itemId = item.id;

  async function doArchive() {
    'use server';
    await archiveItem(itemId);
  }

  async function doRestore() {
    'use server';
    await restoreItem(itemId);
  }

  return (
    <div className="mx-auto max-w-7xl">
      <ItemHeader
        item={item}
        actions={
          <ItemOverflowMenu
            itemId={item.id}
            isArchived={item.archivedAt !== null}
            initialIncludeInSuggestions={item.includeInSuggestions}
            onArchive={doArchive}
            onRestore={doRestore}
          />
        }
      />
      <div className="grid gap-6 md:grid-cols-3">
        <div className="md:col-span-2">
          <ItemTabs active={tab} itemId={item.id} />
          <div className="mt-6">
            {tab === 'overview' && <OverviewTab item={item} />}
            {tab === 'warranties' && <WarrantiesTab item={item} />}
            {tab === 'service' && <ServiceTab item={item} />}
            {tab === 'reminders' && <RemindersTab item={item} />}
            {tab === 'notes' && <NotesTab item={item} />}
            {tab === 'files' && <FilesTab item={item} />}
          </div>
        </div>
        <aside className="md:col-span-1">
          <ItemMetaCard item={item} />
        </aside>
      </div>
    </div>
  );
}
