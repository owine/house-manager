import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

let currentUserId: string | null = 'test-user';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => (currentUserId ? { user: { id: currentUserId } } : null)),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

vi.mock('@/lib/search/client', () => ({
  enqueueSearchIndex: vi.fn(async () => {}),
}));

let ctx: IntegrationContext;
let actions: typeof import('@/lib/systems/actions');
let categoryId: string;

beforeAll(async () => {
  ctx = await setupIntegration();
  actions = await import('@/lib/systems/actions');
  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'systems-actions' },
    create: { slug: 'systems-actions', name: 'HVAC', sortOrder: 22 },
    update: {},
  });
  categoryId = cat.id;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  currentUserId = 'test-user';
  await ctx.prisma.itemVendor.deleteMany();
  await ctx.prisma.systemVendor.deleteMany();
  await ctx.prisma.item.deleteMany();
  await ctx.prisma.system.deleteMany();
  await ctx.prisma.vendor.deleteMany();
});

describe('createSystem', () => {
  it('creates a system with the minimum payload', async () => {
    const r = await actions.createSystem({ name: 'HVAC' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const found = await ctx.prisma.system.findUnique({ where: { id: r.data.id } });
    expect(found?.name).toBe('HVAC');
  });

  it('rejects a payload without a name', async () => {
    const r = await actions.createSystem({});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.fieldErrors).toBeDefined();
  });

  it('returns Unauthorized when no session', async () => {
    currentUserId = null;
    const r = await actions.createSystem({ name: 'HVAC' });
    expect(r).toEqual({ ok: false, formError: 'Unauthorized' });
  });
});

describe('updateSystem', () => {
  it('updates fields by id', async () => {
    const sys = await ctx.prisma.system.create({ data: { name: 'HVAC' } });
    const r = await actions.updateSystem({ id: sys.id, location: 'Garage' });
    expect(r.ok).toBe(true);
    const found = await ctx.prisma.system.findUnique({ where: { id: sys.id } });
    expect(found?.location).toBe('Garage');
  });

  it('rejects when id missing', async () => {
    const r = await actions.updateSystem({ location: 'Garage' });
    expect(r.ok).toBe(false);
  });
});

describe('archiveSystem / unarchiveSystem', () => {
  it('archives and unarchives a system', async () => {
    const sys = await ctx.prisma.system.create({ data: { name: 'HVAC' } });
    const a = await actions.archiveSystem(sys.id);
    expect(a.ok).toBe(true);
    let found = await ctx.prisma.system.findUnique({ where: { id: sys.id } });
    expect(found?.archivedAt).toBeInstanceOf(Date);

    const u = await actions.unarchiveSystem(sys.id);
    expect(u.ok).toBe(true);
    found = await ctx.prisma.system.findUnique({ where: { id: sys.id } });
    expect(found?.archivedAt).toBeNull();
  });
});

describe('assignItemToSystem / unassignItemFromSystem', () => {
  it('assigns and unassigns an item', async () => {
    const sys = await ctx.prisma.system.create({ data: { name: 'HVAC' } });
    const item = await ctx.prisma.item.create({ data: { name: 'Furnace', categoryId } });

    const a = await actions.assignItemToSystem({ itemId: item.id, systemId: sys.id });
    expect(a.ok).toBe(true);
    let row = await ctx.prisma.item.findUnique({ where: { id: item.id } });
    expect(row?.systemId).toBe(sys.id);

    const u = await actions.unassignItemFromSystem({ itemId: item.id });
    expect(u.ok).toBe(true);
    row = await ctx.prisma.item.findUnique({ where: { id: item.id } });
    expect(row?.systemId).toBeNull();
  });
});

describe('addSystemVendor / updateSystemVendor / removeSystemVendor', () => {
  it('round-trips a vendor link with vendorId', async () => {
    const sys = await ctx.prisma.system.create({ data: { name: 'HVAC' } });
    const vendor = await ctx.prisma.vendor.create({ data: { name: 'Acme HVAC' } });

    const add = await actions.addSystemVendor({
      systemId: sys.id,
      vendorId: vendor.id,
      freeformName: null,
      role: 'INSTALLER',
      notes: null,
    });
    expect(add.ok).toBe(true);
    if (!add.ok) return;

    const upd = await actions.updateSystemVendor({
      id: add.data.id,
      vendorId: vendor.id,
      freeformName: null,
      role: 'SERVICE',
      notes: 'updated',
    });
    expect(upd.ok).toBe(true);

    const after = await ctx.prisma.systemVendor.findUnique({ where: { id: add.data.id } });
    expect(after?.role).toBe('SERVICE');
    expect(after?.notes).toBe('updated');

    const del = await actions.removeSystemVendor({ id: add.data.id });
    expect(del.ok).toBe(true);
    const gone = await ctx.prisma.systemVendor.findUnique({ where: { id: add.data.id } });
    expect(gone).toBeNull();
  });

  it('rejects a link with both vendorId and freeformName', async () => {
    const sys = await ctx.prisma.system.create({ data: { name: 'HVAC' } });
    const vendor = await ctx.prisma.vendor.create({ data: { name: 'Acme' } });

    const r = await actions.addSystemVendor({
      systemId: sys.id,
      vendorId: vendor.id,
      freeformName: 'also bob',
      role: 'INSTALLER',
      notes: null,
    });
    expect(r.ok).toBe(false);
  });

  it('accepts a freeform-only link', async () => {
    const sys = await ctx.prisma.system.create({ data: { name: 'HVAC' } });
    const r = await actions.addSystemVendor({
      systemId: sys.id,
      vendorId: null,
      freeformName: 'Free vendor',
      role: 'OTHER',
      notes: null,
    });
    expect(r.ok).toBe(true);
  });
});
