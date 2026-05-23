'use server';
import { createId } from '@paralleldrive/cuid2';
import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { enqueueEmbed } from '@/lib/embedding/enqueue';
import type { ActionResult } from '@/lib/result';
import { enqueueSearchIndex } from '@/lib/search/client';
import type { TargetInput } from '@/lib/targets/schema';
import { withWeeklyAnchor } from './anchor';
import { computeNextDueOn } from './recurrence';
import {
  completeReminderSchema,
  createReminderSchema,
  parseRecurrence,
  updateReminderSchema,
} from './schema';

// Composite where for ownership-gated reminder lookups. A reminder is "owned"
// by every user listed in its notifyUserIds array; only those users may
// update / delete / setActive / complete it. Repeated in four call sites
// below — kept as a helper so the access predicate has one definition.
function ownedReminderWhere(id: string, userId: string) {
  return { id, notifyUserIds: { has: userId } } as const;
}

function revalidateReminderPaths(
  targets: { itemId: string | null; systemId: string | null }[],
  reminderId: string,
) {
  revalidatePath('/reminders');
  revalidatePath(`/reminders/${reminderId}`);
  revalidatePath('/dashboard');
  for (const t of targets) {
    if (t.itemId) revalidatePath(`/items/${t.itemId}`);
    if (t.systemId) revalidatePath(`/systems/${t.systemId}`);
  }
}

async function validateTargets(targets: TargetInput[]): Promise<string | null> {
  const itemIds = targets.map((t) => t.itemId).filter((v): v is string => Boolean(v));
  const systemIds = targets.map((t) => t.systemId).filter((v): v is string => Boolean(v));

  if (itemIds.length > 0) {
    const found = await prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: { id: true },
    });
    if (found.length !== new Set(itemIds).size) return 'Item not found';
  }
  if (systemIds.length > 0) {
    const found = await prisma.system.findMany({
      where: { id: { in: systemIds } },
      select: { id: true },
    });
    if (found.length !== new Set(systemIds).size) return 'System not found';
  }
  return null;
}

export async function createReminder(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, formError: 'Unauthorized' };

  const parsed = createReminderSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { targets, description, notifyUserIds, nextDueOn, recurrence, ...rest } = parsed.data;

  const targetErr = await validateTargets(targets);
  if (targetErr) return { ok: false, formError: targetErr };

  const reminder = await prisma.reminder.create({
    data: {
      ...rest,
      // Stamp a stable anchor for bi-weekly+ weekly recurrences (no-op
      // otherwise) so parity doesn't drift across completions. Seed = nextDueOn.
      recurrence: withWeeklyAnchor(recurrence, nextDueOn),
      description: description || null,
      notifyUserIds: notifyUserIds && notifyUserIds.length > 0 ? notifyUserIds : [session.user.id],
      targets: {
        create: targets.map((t) => ({
          itemId: t.itemId ?? null,
          systemId: t.systemId ?? null,
          nextDueOn,
          // lastCompletedOn is null on creation
        })),
      },
    },
    select: {
      id: true,
      targets: { select: { itemId: true, systemId: true } },
    },
  });
  await enqueueSearchIndex('reminder', reminder.id, 'upsert');

  revalidateReminderPaths(reminder.targets, reminder.id);
  return { ok: true, data: { id: reminder.id } };
}

export async function updateReminder(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, formError: 'Unauthorized' };

  const parsed = updateReminderSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { id, targets, description, notifyUserIds, nextDueOn, recurrence, ...rest } = parsed.data;

  // Ownership-gated lookup: a user can only update reminders they're notified
  // on. findFirst (not findUnique) so we can compose the `notifyUserIds.has`
  // filter; uniform "Not found" response avoids leaking existence of
  // reminders that belong to other users.
  const existing = await prisma.reminder.findFirst({
    where: ownedReminderWhere(id, session.user.id),
    select: {
      id: true,
      targets: { select: { id: true, itemId: true, systemId: true } },
    },
  });
  if (!existing) return { ok: false, formError: 'Not found' };

  if (targets !== undefined) {
    const targetErr = await validateTargets(targets);
    if (targetErr) return { ok: false, formError: targetErr };
  }

  const data: Record<string, unknown> = { ...rest };
  if ('description' in parsed.data) data.description = description || null;
  if (notifyUserIds !== undefined) data.notifyUserIds = notifyUserIds;
  if (recurrence !== undefined) {
    // Re-anchor on any weekly edit so bi-weekly+ parity follows the (possibly
    // new) seed. Prefer the supplied nextDueOn; the combined create/update form
    // always submits both, but if recurrence is changed without nextDueOn fall
    // back to the earliest existing target's nextDueOn as the anchor seed.
    let seedDueOn = nextDueOn;
    if (!seedDueOn && recurrence.kind === 'weekly' && recurrence.interval > 1) {
      const earliest = await prisma.reminderTarget.findFirst({
        where: { reminderId: id },
        orderBy: { nextDueOn: 'asc' },
        select: { nextDueOn: true },
      });
      seedDueOn = earliest?.nextDueOn ?? new Date();
    }
    data.recurrence = withWeeklyAnchor(recurrence, seedDueOn ?? new Date());
  }

  await prisma.$transaction(async (tx) => {
    await tx.reminder.update({ where: { id }, data });

    if (targets !== undefined) {
      const key = (t: { itemId?: string | null; systemId?: string | null }) =>
        `${t.itemId ?? ''}|${t.systemId ?? ''}`;
      const wantSet = new Set(targets.map(key));
      const haveSet = new Set(existing.targets.map(key));

      const toDelete = existing.targets.filter((e) => !wantSet.has(key(e))).map((e) => e.id);
      const toAdd = targets.filter((t) => !haveSet.has(key(t)));

      if (toDelete.length > 0) {
        await tx.reminderTarget.deleteMany({ where: { id: { in: toDelete } } });
      }
      if (toAdd.length > 0) {
        // For new targets, seed nextDueOn from the request value, or — if not
        // provided — fall back to the earliest existing target's nextDueOn.
        let seedNextDueOn = nextDueOn;
        if (!seedNextDueOn) {
          const anyExisting = await tx.reminderTarget.findFirst({
            where: { reminderId: id },
            orderBy: { nextDueOn: 'asc' },
            select: { nextDueOn: true },
          });
          seedNextDueOn = anyExisting?.nextDueOn ?? new Date();
        }
        await tx.reminderTarget.createMany({
          data: toAdd.map((t) => ({
            reminderId: id,
            itemId: t.itemId ?? null,
            systemId: t.systemId ?? null,
            nextDueOn: seedNextDueOn,
          })),
        });
      }
    }

    // If nextDueOn is provided WITHOUT a targets change, propagate it to all
    // existing target rows (matches the single-target form semantics).
    if (nextDueOn !== undefined && targets === undefined) {
      await tx.reminderTarget.updateMany({
        where: { reminderId: id },
        data: { nextDueOn },
      });
    }
  });

  await enqueueSearchIndex('reminder', id, 'upsert');
  // Revalidate previous + new target paths
  revalidateReminderPaths(existing.targets, id);
  if (targets)
    revalidateReminderPaths(
      targets.map((t) => ({ itemId: t.itemId ?? null, systemId: t.systemId ?? null })),
      id,
    );

  return { ok: true, data: { id } };
}

export async function deleteReminder(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, formError: 'Unauthorized' };

  const existing = await prisma.reminder.findFirst({
    where: ownedReminderWhere(id, session.user.id),
    select: { targets: { select: { itemId: true, systemId: true } } },
  });
  if (!existing) return { ok: false, formError: 'Not found' };

  await prisma.reminder.delete({ where: { id } });
  await enqueueSearchIndex('reminder', id, 'delete');
  revalidateReminderPaths(existing.targets, id);
  return { ok: true, data: undefined };
}

export async function setReminderActive(
  id: string,
  active: boolean,
): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, formError: 'Unauthorized' };

  const existing = await prisma.reminder.findFirst({
    where: ownedReminderWhere(id, session.user.id),
    select: { id: true, targets: { select: { itemId: true, systemId: true } } },
  });
  if (!existing) return { ok: false, formError: 'Not found' };

  await prisma.reminder.update({ where: { id }, data: { active } });
  await enqueueSearchIndex('reminder', id, 'upsert');
  revalidateReminderPaths(existing.targets, id);
  return { ok: true, data: { id } };
}

export async function completeReminder(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, formError: 'Unauthorized' };
  const userId = session.user.id;

  const parsed = completeReminderSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { id, targetIds, notes, serviceRecord } = parsed.data;

  // Ownership-gated lookup — see updateReminder for rationale. Completing a
  // reminder writes ReminderCompletion rows attributed to userId + advances
  // each named target's nextDueOn.
  const reminder = await prisma.reminder.findFirst({
    where: ownedReminderWhere(id, userId),
    select: {
      id: true,
      recurrence: true,
      autoCreateServiceRecord: true,
      targets: { select: { id: true, itemId: true, systemId: true } },
    },
  });
  if (!reminder) return { ok: false, formError: 'Not found' };
  if (reminder.targets.length === 0) return { ok: false, formError: 'Reminder has no targets' };

  // Default to all targets if the caller didn't specify (back-compat with the
  // single-target callers — the old action completed "the reminder" wholesale).
  const targetById = new Map(reminder.targets.map((t) => [t.id, t]));
  const selectedIds =
    targetIds && targetIds.length > 0 ? targetIds : reminder.targets.map((t) => t.id);
  for (const tid of selectedIds) {
    if (!targetById.has(tid)) return { ok: false, formError: 'Target not found' };
  }

  const now = new Date();
  const recurrence = parseRecurrence(reminder.recurrence);
  const nextDueOn = computeNextDueOn(recurrence, now);

  const completionToServiceRecord = new Map<string, string>();

  await prisma.$transaction(async (tx) => {
    for (const tid of selectedIds) {
      const target = targetById.get(tid);
      if (!target) continue;

      const completion = await tx.reminderCompletion.create({
        data: {
          id: createId(),
          reminderId: id,
          targetId: tid,
          completedById: userId,
          completedOn: now,
          notes: notes || null,
        },
        select: { id: true },
      });

      await tx.reminderTarget.update({
        where: { id: tid },
        data: { lastCompletedOn: now, nextDueOn },
      });

      if (reminder.autoCreateServiceRecord && serviceRecord) {
        // Mirror the target's parent (item or system) onto a fresh
        // ServiceRecord + ServiceRecordTarget so the multi-target shape
        // stays consistent post-Task-2.
        const sr = await tx.serviceRecord.create({
          data: {
            performedOn: now,
            summary: serviceRecord.summary,
            notes: serviceRecord.notes || null,
            cost: serviceRecord.cost,
            vendorId: serviceRecord.vendorId ?? null,
            targets: {
              create: [
                {
                  itemId: target.itemId ?? null,
                  systemId: target.systemId ?? null,
                },
              ],
            },
          },
          select: { id: true },
        });
        await tx.reminderCompletion.update({
          where: { id: completion.id },
          data: { createdServiceRecordId: sr.id },
        });
        completionToServiceRecord.set(completion.id, sr.id);
      }
    }
  });

  for (const srId of completionToServiceRecord.values()) {
    await enqueueSearchIndex('service', srId, 'upsert');
    await enqueueEmbed('SERVICE_RECORD', srId);
  }
  await enqueueSearchIndex('reminder', id, 'upsert');

  revalidateReminderPaths(reminder.targets, id);
  return { ok: true, data: { id } };
}
