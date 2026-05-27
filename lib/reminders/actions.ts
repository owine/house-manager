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

async function validateTargets(
  targets: TargetInput[],
  kind: 'REMINDER' | 'CHORE',
): Promise<string | null> {
  // Cardinality: REMINDER requires ≥1 link (asset-centric). CHORE allows
  // 0..N — a linkless chore is reconciled into a single standalone
  // (both-NULL) ReminderTarget by the create/update paths below.
  if (kind === 'REMINDER' && targets.length === 0) {
    return 'Select at least one item or system';
  }
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

  // Invariant: autoComplete is only meaningful for CHOREs. Coerce at the server
  // layer regardless of what the client submitted — UI restriction alone is not
  // the contract.
  if (rest.kind !== 'CHORE') {
    (rest as { autoComplete: boolean }).autoComplete = false;
  }

  const targetErr = await validateTargets(targets, parsed.data.kind);
  if (targetErr) return { ok: false, formError: targetErr };

  // CHORE with 0 user-submitted links → reconcile to a single "standalone"
  // ReminderTarget row (both itemId and systemId NULL) that carries
  // nextDueOn / lastCompletedOn / completions. REMINDER never hits this
  // branch (validateTargets already rejected length === 0).
  const reconciledTargets =
    parsed.data.kind === 'CHORE' && targets.length === 0
      ? [{ itemId: null, systemId: null } as TargetInput]
      : targets;

  const reminder = await prisma.reminder.create({
    data: {
      ...rest,
      // Stamp a stable anchor for bi-weekly+ weekly recurrences (no-op
      // otherwise) so parity doesn't drift across completions. Seed = nextDueOn.
      recurrence: withWeeklyAnchor(recurrence, nextDueOn),
      description: description || null,
      notifyUserIds: notifyUserIds && notifyUserIds.length > 0 ? notifyUserIds : [session.user.id],
      targets: {
        create: reconciledTargets.map((t) => ({
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
      kind: true,
      targets: {
        select: {
          id: true,
          itemId: true,
          systemId: true,
          lastCompletedOn: true,
          nextDueOn: true,
        },
      },
    },
  });
  if (!existing) return { ok: false, formError: 'Not found' };

  if (targets !== undefined) {
    // updateReminderSchema's third (kind-omitted) arm forces targets to
    // be undefined, so any defined `targets` here is paired with a defined
    // `parsed.data.kind`. The fallback to existing.kind is belt-and-braces.
    const effectiveKind = parsed.data.kind ?? existing.kind;
    const targetErr = await validateTargets(targets, effectiveKind);
    if (targetErr) return { ok: false, formError: targetErr };
  }

  // Coerce autoComplete to false if the effective kind is not CHORE.
  // This covers three cases: (a) explicit kind=REMINDER in the payload,
  // (b) kind-omitted update where the existing row is a REMINDER, and
  // (c) a kind flip from CHORE → REMINDER (clear the previously-true flag).
  // Only touch the field if it was actually present in the parsed payload
  // so we don't fabricate a write on every update of a CHORE.
  const effectiveKindForCoerce = parsed.data.kind ?? existing.kind;
  if (effectiveKindForCoerce !== 'CHORE' && 'autoComplete' in parsed.data) {
    (rest as Record<string, unknown>).autoComplete = false;
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
      const isChore = (parsed.data.kind ?? existing.kind) === 'CHORE';
      // Schema guarantees user-submitted rows are link-only (XOR per targetSchema),
      // so we never see a both-NULL from `targets`. Split existing target rows
      // into the two shapes — at most one standalone, the rest links.
      const submittedLinks = targets;
      const existingLinks = existing.targets.filter(
        (t) => t.itemId !== null || t.systemId !== null,
      );
      // Invariant: a standalone (both-NULL) row only exists under a CHORE
      // parent — server reconciliation never mints one alongside link rows,
      // and the NULLS NOT DISTINCT unique caps them at 1/reminder. The three
      // branches below rely on this; the schema's REMINDER+empty rejection
      // keeps a CHORE→REMINDER kind flip with empty targets from sneaking
      // into the standalone branch.
      const existingStandalone = existing.targets.find(
        (t) => t.itemId === null && t.systemId === null,
      );

      if (isChore && submittedLinks.length === 0) {
        // Reconcile to standalone shape. If there isn't one already, mint it
        // and inherit schedule from the most-recently-completed existing link
        // (tie-break by earliest nextDueOn) so cadence carries over.
        if (!existingStandalone) {
          const seed = existingLinks.slice().sort((a, b) => {
            const ac = a.lastCompletedOn?.getTime() ?? Number.NEGATIVE_INFINITY;
            const bc = b.lastCompletedOn?.getTime() ?? Number.NEGATIVE_INFINITY;
            if (ac !== bc) return bc - ac;
            return a.nextDueOn.getTime() - b.nextDueOn.getTime();
          })[0];
          await tx.reminderTarget.create({
            data: {
              reminderId: id,
              itemId: null,
              systemId: null,
              lastCompletedOn: seed?.lastCompletedOn ?? null,
              nextDueOn: seed?.nextDueOn ?? nextDueOn ?? new Date(),
            },
          });
        }
        if (existingLinks.length > 0) {
          await tx.reminderTarget.deleteMany({
            where: { id: { in: existingLinks.map((l) => l.id) } },
          });
        }
      } else if (existingStandalone) {
        // standalone → links: seed every newly-inserted link with the
        // standalone's schedule (carry cadence forward), then drop the
        // standalone. existingLinks should be empty in practice but we
        // still respect dedup against it for safety.
        const seedNext = existingStandalone.nextDueOn;
        const seedLast = existingStandalone.lastCompletedOn;
        const haveKey = new Set(existingLinks.map((t) => `${t.itemId ?? ''}|${t.systemId ?? ''}`));
        const toAdd = submittedLinks.filter(
          (t) => !haveKey.has(`${t.itemId ?? ''}|${t.systemId ?? ''}`),
        );
        if (toAdd.length > 0) {
          await tx.reminderTarget.createMany({
            data: toAdd.map((t) => ({
              reminderId: id,
              itemId: t.itemId ?? null,
              systemId: t.systemId ?? null,
              nextDueOn: seedNext,
              lastCompletedOn: seedLast,
            })),
          });
        }
        await tx.reminderTarget.delete({ where: { id: existingStandalone.id } });
      } else {
        // links → links: original diff behavior, scoped to link rows only.
        const key = (t: { itemId?: string | null; systemId?: string | null }) =>
          `${t.itemId ?? ''}|${t.systemId ?? ''}`;
        const wantSet = new Set(submittedLinks.map(key));
        const haveSet = new Set(existingLinks.map(key));

        const toDelete = existingLinks.filter((e) => !wantSet.has(key(e))).map((e) => e.id);
        const toAdd = submittedLinks.filter((t) => !haveSet.has(key(t)));

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
