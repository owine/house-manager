'use server';
import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import type { ActionResult } from '@/lib/result';
import { houseProfileSchema } from './schema';

export async function saveHouseProfile(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const parsed = houseProfileSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  // Convert '' to null so empty form fields actually clear the DB column.
  const data = {
    location: parsed.data.location || null,
    climateZone: parsed.data.climateZone || null,
    propertyType: parsed.data.propertyType ?? null,
    timezone: parsed.data.timezone,
  };

  // find-or-create is not atomic: if two writers race on a fresh DB, both could
  // see no existing row and both call create, yielding two rows. For this app
  // (single-user, single-process) this is a non-issue and not guarded against.
  const existing = await prisma.houseProfile.findFirst();
  const saved = existing
    ? await prisma.houseProfile.update({ where: { id: existing.id }, data })
    : await prisma.houseProfile.create({ data });

  revalidatePath('/settings');
  revalidatePath('/dashboard'); // dashboard may surface this in Task 17
  return { ok: true, data: { id: saved.id } };
}
