import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ComponentsList } from '@/components/systems/ComponentsList';
import { CostRollup } from '@/components/systems/CostRollup';
import { SystemHeader } from '@/components/systems/SystemHeader';
import { SystemTimeline, type TimelineEvent } from '@/components/systems/SystemTimeline';
import { SystemVendorsSection } from '@/components/systems/SystemVendorsSection';
import type { VendorLinkRow } from '@/components/vendor-links/VendorLinkChips';
import { listOrphanItems } from '@/lib/items/queries';
import { getRemindersForSystem } from '@/lib/reminders/queries';
import { getServiceRecordsForSystem } from '@/lib/service-records/queries';
import { archiveSystem, unarchiveSystem } from '@/lib/systems/actions';
import { getSystemDetail } from '@/lib/systems/queries';
import { listAllVendors } from '@/lib/vendors/queries';
import { getWarrantiesForSystem } from '@/lib/warranties/queries';

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const detail = await getSystemDetail(id);
  return { title: detail?.system.name ?? 'Not found' };
}

type TargetWithRefs = {
  itemId: string | null;
  systemId: string | null;
  item: { id: string; name: string } | null;
  system: { id: string; name: string } | null;
};

function buildTargets(
  systemId: string,
  targets: TargetWithRefs[],
): {
  chips: { kind: 'item' | 'system'; id: string; name: string }[];
  hasSystemTarget: boolean;
  hasItemTarget: boolean;
} {
  const chips: { kind: 'item' | 'system'; id: string; name: string }[] = [];
  let hasSystemTarget = false;
  let hasItemTarget = false;
  for (const t of targets) {
    if (t.system) {
      if (t.system.id === systemId) hasSystemTarget = true;
      chips.push({ kind: 'system', id: t.system.id, name: t.system.name });
    } else if (t.item) {
      hasItemTarget = true;
      chips.push({ kind: 'item', id: t.item.id, name: t.item.name });
    }
  }
  return { chips, hasSystemTarget, hasItemTarget };
}

export default async function SystemDetailPage({ params }: { params: Params }) {
  const { id } = await params;

  const detail = await getSystemDetail(id);
  if (!detail) notFound();
  const { system, rollup } = detail;

  // Run the three event queries plus orphan/vendor queries in parallel.
  const [serviceRecords, warranties, reminders, orphanItems, vendors] = await Promise.all([
    getServiceRecordsForSystem(id),
    getWarrantiesForSystem(id),
    getRemindersForSystem(id),
    listOrphanItems(),
    listAllVendors(),
  ]);

  const events: TimelineEvent[] = [];
  for (const sr of serviceRecords) {
    const { chips, hasSystemTarget, hasItemTarget } = buildTargets(id, sr.targets);
    events.push({
      id: sr.id,
      type: 'service',
      date: sr.performedOn,
      summary: sr.summary,
      href: `/service/${sr.id}`,
      targets: chips,
      hasSystemTarget,
      hasItemTarget,
    });
  }
  for (const w of warranties) {
    const { chips, hasSystemTarget, hasItemTarget } = buildTargets(id, w.targets);
    events.push({
      id: w.id,
      type: 'warranty',
      date: w.endsOn,
      summary: `${w.provider}${w.policyNumber ? ` · ${w.policyNumber}` : ''}`,
      href: `/warranties/${w.id}`,
      targets: chips,
      hasSystemTarget,
      hasItemTarget,
    });
  }
  for (const r of reminders) {
    const { chips, hasSystemTarget, hasItemTarget } = buildTargets(id, r.targets);
    events.push({
      id: r.id,
      type: 'reminder',
      date: r.nextDueOn ?? new Date(0),
      summary: r.title,
      href: `/reminders/${r.id}`,
      targets: chips,
      hasSystemTarget,
      hasItemTarget,
    });
  }
  events.sort((a, b) => b.date.getTime() - a.date.getTime());

  const vendorLinks: VendorLinkRow[] = system.systemVendors.map((sv) => ({
    id: sv.id,
    vendorId: sv.vendorId,
    vendorName: sv.vendor?.name ?? null,
    freeformName: sv.freeformName,
    role: sv.role,
    notes: sv.notes,
  }));

  async function doArchive() {
    'use server';
    const r = await archiveSystem(id);
    return r.ok ? { ok: true as const } : { ok: false as const, formError: r.formError };
  }
  async function doUnarchive() {
    'use server';
    const r = await unarchiveSystem(id);
    return r.ok ? { ok: true as const } : { ok: false as const, formError: r.formError };
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <SystemHeader
        system={{
          id: system.id,
          name: system.name,
          kind: system.kind,
          location: system.location,
          installDate: system.installDate,
          archivedAt: system.archivedAt,
        }}
        onArchive={doArchive}
        onUnarchive={doUnarchive}
      />
      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        <div className="space-y-6 md:col-span-2">
          <ComponentsList
            systemId={system.id}
            components={system.items.map((i) => ({
              id: i.id,
              name: i.name,
              manufacturer: i.manufacturer,
              model: i.model,
            }))}
            orphanItems={orphanItems.map((i) => ({
              id: i.id,
              name: i.name,
              manufacturer: i.manufacturer,
              model: i.model,
            }))}
          />
          <SystemVendorsSection systemId={system.id} links={vendorLinks} vendors={vendors} />
          <SystemTimeline events={events} systemId={system.id} />
        </div>
        <aside className="space-y-6 md:col-span-1">
          <CostRollup rollup={rollup} />
        </aside>
      </div>
    </div>
  );
}
