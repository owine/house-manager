'use server';
import type { PartKind, Prisma, VendorRole } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { prisma, type TransactionClient } from '@/lib/db';
import { enqueueEmbed } from '@/lib/embedding/enqueue';
import { enqueueSystemRenameCascade } from '@/lib/rename-cascade';
import type { ActionResult } from '@/lib/result';
import { enqueueSearchIndex } from '@/lib/search/client';
import { vendorLinkSchema } from '@/lib/vendor-links/schema';
import { createSystemSchema, updateSystemWithIdSchema } from './schema';

function emptyToUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = v === '' ? undefined : v;
  return out as T;
}

function revalidateSystemPaths(id?: string) {
  revalidatePath('/systems');
  if (id) revalidatePath(`/systems/${id}`);
}

export async function createSystem(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const parsed = createSystemSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const system = await prisma.system.create({ data: emptyToUndefined(parsed.data) });
  revalidateSystemPaths(system.id);
  return { ok: true, data: { id: system.id } };
}

export async function updateSystem(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const parsed = updateSystemWithIdSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const { id, ...rest } = parsed.data;
  await prisma.system.update({ where: { id }, data: emptyToUndefined(rest) });
  await enqueueSystemRenameCascade(id);
  revalidateSystemPaths(id);
  return { ok: true, data: { id } };
}

export async function archiveSystem(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  await prisma.system.update({ where: { id }, data: { archivedAt: new Date() } });
  revalidateSystemPaths(id);
  return { ok: true, data: undefined };
}

export async function unarchiveSystem(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  await prisma.system.update({ where: { id }, data: { archivedAt: null } });
  revalidateSystemPaths(id);
  return { ok: true, data: undefined };
}

// ---------- Deleting a system that has parts ----------

export type SystemPartSummary = {
  id: string;
  name: string;
  kind: PartKind;
  /** Every one of this part's links points at the system being deleted. */
  willBeOrphaned: boolean;
};

/**
 * `PartLink.system` is `onDelete: Cascade`, so deleting a system succeeds
 * silently and takes its link rows with it. There is no RESTRICT violation to
 * catch, which is why this is a **pre-query** and not the `tryDeleteVendor`
 * probe: that pattern needs the database to say no, and here it says yes.
 * The same holds for the reminder/warranty/service-record target tables —
 * see findSystemDeleteBlockers.
 */
export type TryDeleteSystemResult =
  | { ok: true }
  | { ok: false; hasDependents: true; dependents: SystemDependentSummary[] }
  | { ok: false; hasParts: true; parts: SystemPartSummary[] }
  | { ok: false; formError: string };

/**
 * Selected identically by the pre-query and the in-transaction re-read so the
 * two cannot drift. `_count.links` is the part's link count across the whole
 * house, which is what makes `willBeOrphaned` answerable in one round trip.
 */
const SYSTEM_PART_LINK_SELECT = {
  part: {
    select: { id: true, name: true, kind: true, _count: { select: { links: true } } },
  },
} satisfies Prisma.PartLinkSelect;

type SystemPartLinkRow = {
  part: { id: string; name: string; kind: PartKind; _count: { links: number } };
};

function summarizeSystemParts(links: SystemPartLinkRow[]): SystemPartSummary[] {
  // A part may hold more than one link to the same system (two locations), so
  // count our own links per part before asking whether they are all of them.
  const ownLinks = new Map<string, number>();
  for (const l of links) ownLinks.set(l.part.id, (ownLinks.get(l.part.id) ?? 0) + 1);

  const seen = new Set<string>();
  const out: SystemPartSummary[] = [];
  for (const { part } of links) {
    if (seen.has(part.id)) continue;
    seen.add(part.id);
    out.push({
      id: part.id,
      name: part.name,
      kind: part.kind,
      willBeOrphaned: part._count.links === (ownLinks.get(part.id) ?? 0),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// ---------- Records that would be left pointing at nothing ----------

export type SystemDependentSummary = {
  kind: 'reminder' | 'warranty' | 'serviceRecord';
  id: string;
  label: string;
};

/** Thrown inside the transaction to force a rollback — same lever as StaleSystemPartsError. */
class SystemDeleteBlockedError extends Error {
  constructor(readonly dependents: SystemDependentSummary[]) {
    super('system delete blocked by dependents');
  }
}

function targetsOnlyThisSystem(systemId: string, targets: { systemId: string | null }[]): boolean {
  return targets.length > 0 && targets.every((t) => t.systemId === systemId);
}

const byLabel = (a: SystemDependentSummary, b: SystemDependentSummary) =>
  a.label.localeCompare(b.label);

/**
 * Records whose ONLY target is this system. The target tables cascade from
 * `System` (prisma/schema.prisma), so deleting it would silently leave them
 * with none — and every "must have a target" rule here is app-level only:
 *   - REMINDER needs ≥1 target: reminders-tick iterates target rows, the iCal
 *     feed skips it, completeReminder refuses "Reminder has no targets".
 *   - Warranty needs ≥1 target (targetsArraySchema); there is no warranty list
 *     page, so a target-less warranty is unreachable.
 *   - Service record needs a vendor, the self-performed marker, or ≥1 target
 *     (requireAnchor in lib/service-records/schema.ts). One that keeps a vendor
 *     or the marker stays valid and listed, so only unanchored ones block.
 * CHOREs never block: see detachSoleTargetChores.
 *
 * Filtered in JS rather than with Prisma's `every`: `every: { systemId }` on a
 * nullable column is exactly the three-valued-logic corner that is easy to get
 * wrong, and the candidate set (records with SOME target here) is small.
 */
async function findSystemDeleteBlockers(
  tx: TransactionClient,
  systemId: string,
): Promise<SystemDependentSummary[]> {
  const reminders = await tx.reminder.findMany({
    where: { kind: 'REMINDER', targets: { some: { systemId } } },
    select: { id: true, title: true, targets: { select: { systemId: true } } },
  });
  const warranties = await tx.warranty.findMany({
    where: { targets: { some: { systemId } } },
    select: { id: true, provider: true, targets: { select: { systemId: true } } },
  });
  const serviceRecords = await tx.serviceRecord.findMany({
    where: { targets: { some: { systemId } }, vendorId: null, selfPerformed: false },
    select: { id: true, summary: true, targets: { select: { systemId: true } } },
  });

  return [
    ...reminders
      .filter((r) => targetsOnlyThisSystem(systemId, r.targets))
      .map((r) => ({ kind: 'reminder' as const, id: r.id, label: r.title }))
      .sort(byLabel),
    ...warranties
      .filter((w) => targetsOnlyThisSystem(systemId, w.targets))
      .map((w) => ({ kind: 'warranty' as const, id: w.id, label: w.provider }))
      .sort(byLabel),
    ...serviceRecords
      .filter((s) => targetsOnlyThisSystem(systemId, s.targets))
      .map((s) => ({ kind: 'serviceRecord' as const, id: s.id, label: s.summary }))
      .sort(byLabel),
  ];
}

/**
 * A CHORE whose only target is this system becomes a standalone chore — the
 * item/system/part-all-NULL shape updateReminder reconciles a link-less chore
 * to (lib/reminders/actions.ts). Converted IN PLACE rather than cascaded and
 * re-created, so the row keeps its `nextDueOn`, `lastCompletedOn` and its
 * ReminderCompletion history (which cascades from the target row). Safe
 * against the NULLS NOT DISTINCT unique: a chore whose every target is this
 * system cannot already have a standalone row.
 */
async function detachSoleTargetChores(tx: TransactionClient, systemId: string): Promise<void> {
  const chores = await tx.reminder.findMany({
    where: { kind: 'CHORE', targets: { some: { systemId } } },
    select: { id: true, targets: { select: { systemId: true } } },
  });
  const ids = chores.filter((c) => targetsOnlyThisSystem(systemId, c.targets)).map((c) => c.id);
  if (ids.length === 0) return;
  await tx.reminderTarget.updateMany({
    where: { systemId, reminderId: { in: ids } },
    data: { systemId: null },
  });
}

/**
 * The delete entry point, run as one transaction so the checks and the delete
 * see the same rows. Blockers are reported before parts: asking the user to
 * archive parts only to refuse the delete afterwards would be worse.
 */
export async function tryDeleteSystem(systemId: string): Promise<TryDeleteSystemResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const outcome = await prisma.$transaction(async (tx) => {
    const system = await tx.system.findUnique({ where: { id: systemId }, select: { id: true } });
    if (!system) return { kind: 'missing' as const };

    const dependents = await findSystemDeleteBlockers(tx, systemId);
    if (dependents.length > 0) return { kind: 'blocked' as const, dependents };

    const parts = summarizeSystemParts(
      await tx.partLink.findMany({ where: { systemId }, select: SYSTEM_PART_LINK_SELECT }),
    );
    if (parts.length > 0) return { kind: 'parts' as const, parts };

    await detachSoleTargetChores(tx, systemId);
    await tx.system.delete({ where: { id: systemId } });
    return { kind: 'deleted' as const };
  });

  if (outcome.kind === 'missing') return { ok: false, formError: 'System not found' };
  if (outcome.kind === 'blocked') {
    return { ok: false, hasDependents: true, dependents: outcome.dependents };
  }
  if (outcome.kind === 'parts') return { ok: false, hasParts: true, parts: outcome.parts };

  revalidateAfterSystemDelete();
  return { ok: true };
}

function revalidateAfterSystemDelete() {
  revalidatePath('/systems');
  revalidatePath('/items');
  revalidatePath('/parts');
  // Reminders, chores and warranties may have lost a target chip.
  revalidatePath('/reminders');
  revalidatePath('/chores');
  revalidatePath('/dashboard');
}

const deleteSystemWithPartsInput = z.object({
  systemId: z.string().min(1),
  archivePartIds: z.array(z.string().min(1)),
  keepPartIds: z.array(z.string().min(1)),
});

export type DeleteSystemWithPartsResult =
  | ActionResult<{ archivedCount: number; keptCount: number }>
  | { ok: false; hasParts: true; parts: SystemPartSummary[] }
  | { ok: false; hasDependents: true; dependents: SystemDependentSummary[] };

/** Thrown inside the transaction to force a rollback — Prisma has no other lever. */
class StaleSystemPartsError extends Error {
  constructor(readonly parts: SystemPartSummary[]) {
    super('system parts changed');
  }
}

/**
 * Archive the checked parts, unlink the rest, delete the system — one
 * transaction.
 *
 * `keepPartIds` is not redundant with `archivePartIds`. Together they are the
 * set the user actually saw. A part linked between the prompt and the submit is
 * in neither, and deriving "unchecked" from "absent" would silently archive —
 * or silently skip — a part nobody was shown. So the system's links are re-read
 * *inside* the transaction, and any id unaccounted for on either side rolls the
 * whole thing back and returns the fresh list for the dialog to re-render.
 */
export async function deleteSystemWithParts(input: {
  systemId: string;
  archivePartIds: string[];
  keepPartIds: string[];
}): Promise<DeleteSystemWithPartsResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const parsed = deleteSystemWithPartsInput.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { systemId, archivePartIds, keepPartIds } = parsed.data;
  const archiveSet = new Set(archivePartIds);
  const shown = new Set([...archivePartIds, ...keepPartIds]);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const system = await tx.system.findUnique({ where: { id: systemId }, select: { id: true } });
      if (!system) return null;

      // Re-checked here, not trusted from the prompt: a sole-target reminder
      // created between the prompt and the submit must still block.
      const dependents = await findSystemDeleteBlockers(tx, systemId);
      if (dependents.length > 0) throw new SystemDeleteBlockedError(dependents);

      const current = summarizeSystemParts(
        await tx.partLink.findMany({ where: { systemId }, select: SYSTEM_PART_LINK_SELECT }),
      );
      const currentIds = new Set(current.map((p) => p.id));

      const unaccounted =
        current.some((p) => !shown.has(p.id)) || [...shown].some((id) => !currentIds.has(id));
      if (unaccounted) throw new StaleSystemPartsError(current);

      const toArchive = current.filter((p) => archiveSet.has(p.id)).map((p) => p.id);
      if (toArchive.length > 0) {
        await tx.part.updateMany({
          where: { id: { in: toArchive } },
          data: { archivedAt: new Date() },
        });
      }
      await tx.partLink.deleteMany({ where: { systemId } });
      await detachSoleTargetChores(tx, systemId);
      await tx.system.delete({ where: { id: systemId } });

      return {
        archivedCount: toArchive.length,
        keptCount: current.length - toArchive.length,
        touchedPartIds: current.map((p) => p.id),
      };
    });

    if (result === null) return { ok: false, formError: 'System not found' };

    // Every part that was linked to this system loses that parent's name from
    // its search doc and its embedded text, archived or kept alike. An
    // archived part additionally has its embeddings tombstoned by the worker.
    const { touchedPartIds, ...counts } = result;
    for (const partId of touchedPartIds) {
      await enqueueSearchIndex('part', partId, 'upsert');
      await enqueueEmbed('PART', partId);
    }

    revalidateAfterSystemDelete();
    return { ok: true, data: counts };
  } catch (error) {
    if (error instanceof SystemDeleteBlockedError) {
      return { ok: false, hasDependents: true, dependents: error.dependents };
    }
    if (error instanceof StaleSystemPartsError) {
      return { ok: false, hasParts: true, parts: error.parts };
    }
    throw error;
  }
}

// ---------- Component (Item) assignment ----------

const assignItemInput = z.object({
  itemId: z.string().min(1),
  systemId: z.string().min(1),
});

export async function assignItemToSystem(input: {
  itemId: string;
  systemId: string;
}): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const parsed = assignItemInput.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  await prisma.item.update({
    where: { id: parsed.data.itemId },
    data: { systemId: parsed.data.systemId },
  });
  // system.name is part of the Item embed; reassignment must trigger re-embed.
  await enqueueEmbed('ITEM', parsed.data.itemId);
  revalidateSystemPaths(parsed.data.systemId);
  revalidatePath('/items');
  revalidatePath(`/items/${parsed.data.itemId}`);
  return { ok: true, data: undefined };
}

const unassignItemInput = z.object({ itemId: z.string().min(1) });

export async function unassignItemFromSystem(input: {
  itemId: string;
}): Promise<ActionResult<{ previousSystemId: string | null }>> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const parsed = unassignItemInput.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const before = await prisma.item.findUnique({
    where: { id: parsed.data.itemId },
    select: { systemId: true },
  });
  await prisma.item.update({
    where: { id: parsed.data.itemId },
    data: { systemId: null },
  });
  await enqueueEmbed('ITEM', parsed.data.itemId);
  revalidatePath('/systems');
  if (before?.systemId) revalidatePath(`/systems/${before.systemId}`);
  revalidatePath('/items');
  revalidatePath(`/items/${parsed.data.itemId}`);
  return { ok: true, data: { previousSystemId: before?.systemId ?? null } };
}

// ---------- SystemVendor (vendor links) ----------

const addSystemVendorInput = vendorLinkSchema.and(z.object({ systemId: z.string().min(1) }));

export async function addSystemVendor(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const parsed = addSystemVendorInput.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const link = await prisma.systemVendor.create({
    data: {
      systemId: parsed.data.systemId,
      vendorId: parsed.data.vendorId ?? null,
      freeformName: parsed.data.freeformName ?? null,
      role: parsed.data.role as VendorRole,
      notes: parsed.data.notes ?? null,
      serviceContract: parsed.data.serviceContract,
      contractEndsOn: parsed.data.contractEndsOn ?? null,
    },
  });
  revalidateSystemPaths(parsed.data.systemId);
  if (parsed.data.vendorId) revalidatePath(`/vendors/${parsed.data.vendorId}`);
  return { ok: true, data: { id: link.id } };
}

const updateSystemVendorInput = vendorLinkSchema.and(z.object({ id: z.string().min(1) }));

export async function updateSystemVendor(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const parsed = updateSystemVendorInput.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const updated = await prisma.systemVendor.update({
    where: { id: parsed.data.id },
    data: {
      vendorId: parsed.data.vendorId ?? null,
      freeformName: parsed.data.freeformName ?? null,
      role: parsed.data.role as VendorRole,
      notes: parsed.data.notes ?? null,
      serviceContract: parsed.data.serviceContract,
      contractEndsOn: parsed.data.contractEndsOn ?? null,
    },
  });
  revalidateSystemPaths(updated.systemId);
  if (updated.vendorId) revalidatePath(`/vendors/${updated.vendorId}`);
  return { ok: true, data: { id: updated.id } };
}

const removeSystemVendorInput = z.object({ id: z.string().min(1) });

export async function removeSystemVendor(input: { id: string }): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const parsed = removeSystemVendorInput.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const removed = await prisma.systemVendor.delete({ where: { id: parsed.data.id } });
  revalidateSystemPaths(removed.systemId);
  if (removed.vendorId) revalidatePath(`/vendors/${removed.vendorId}`);
  return { ok: true, data: undefined };
}
