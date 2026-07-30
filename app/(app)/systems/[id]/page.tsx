import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { PartsForParent } from '@/components/parts/PartsForParent';
import { ComponentsList } from '@/components/systems/ComponentsList';
import { CostRollup } from '@/components/systems/CostRollup';
import { DeleteSystemButton } from '@/components/systems/DeleteSystemButton';
import { SystemHeader } from '@/components/systems/SystemHeader';
import {
  SystemTimeline,
  type TimelineEvent,
  type TimelineTargetChip,
} from '@/components/systems/SystemTimeline';
import { SystemVendorsSection } from '@/components/systems/SystemVendorsSection';
import type { VendorLinkRow } from '@/components/vendor-links/VendorLinkChips';
import { listOrphanItems } from '@/lib/items/queries';
import { listPartsForParent, listPartsForPicker } from '@/lib/parts/queries';
import { getRemindersForSystem } from '@/lib/reminders/queries';
import { getServiceRecordsForSystem } from '@/lib/service-records/queries';
import {
  archiveSystem,
  deleteSystemWithParts,
  tryDeleteSystem,
  unarchiveSystem,
} from '@/lib/systems/actions';
import { getSystemDetail } from '@/lib/systems/queries';
import { calendarDate } from '@/lib/time/tz';
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
  /** Optional: `warranty_targets` has no `partId` and this helper serves it too. */
  part?: { id: string; name: string } | null;
};

function buildTargets(
  systemId: string,
  targets: TargetWithRefs[],
): {
  chips: TimelineTargetChip[];
  hasSystemTarget: boolean;
  hasItemTarget: boolean;
} {
  const chips: TimelineTargetChip[] = [];
  let hasSystemTarget = false;
  let hasItemTarget = false;
  for (const t of targets) {
    if (t.system) {
      if (t.system.id === systemId) hasSystemTarget = true;
      chips.push({ kind: 'system', id: t.system.id, name: t.system.name });
    } else if (t.item) {
      hasItemTarget = true;
      chips.push({ kind: 'item', id: t.item.id, name: t.item.name });
    } else if (t.part) {
      // A part chip names the target but deliberately does NOT set
      // `hasItemTarget` — the "Components" filter means item-level targets, and
      // reusing it for parts would change what that filter selects.
      chips.push({ kind: 'part', id: t.part.id, name: t.part.name });
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
  const [serviceRecords, warranties, reminders, orphanItems, vendors, partLinks, pickerParts] =
    await Promise.all([
      getServiceRecordsForSystem(id),
      getWarrantiesForSystem(id),
      getRemindersForSystem(id),
      listOrphanItems(),
      listAllVendors(),
      listPartsForParent({ systemId: id }),
      listPartsForPicker(),
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
      // Epoch as an explicit calendar date -- sorts a null due date to the top.
      date: r.nextDueOn ?? calendarDate(1970, 1, 1),
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
    serviceContract: sv.serviceContract,
    contractEndsOn: sv.contractEndsOn,
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

  async function doTryDelete() {
    'use server';
    const r = await tryDeleteSystem(id);
    if (r.ok) return { ok: true as const };
    if ('hasParts' in r) return { ok: false as const, hasParts: true as const, parts: r.parts };
    return { ok: false as const, formError: r.formError };
  }

  async function doDeleteWithParts(input: { archivePartIds: string[]; keepPartIds: string[] }) {
    'use server';
    const r = await deleteSystemWithParts({ systemId: id, ...input });
    if (r.ok) {
      return {
        ok: true as const,
        archivedCount: r.data.archivedCount,
        keptCount: r.data.keptCount,
      };
    }
    if ('hasParts' in r) return { ok: false as const, hasParts: true as const, parts: r.parts };
    return { ok: false as const, formError: r.formError };
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
        extraActions={
          <DeleteSystemButton
            systemName={system.name}
            onTryDelete={doTryDelete}
            onDeleteWithParts={doDeleteWithParts}
          />
        }
      />
      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        <div className="min-w-0 space-y-6 md:col-span-2">
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
          <PartsForParent systemId={system.id} links={partLinks} pickerParts={pickerParts} />
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
