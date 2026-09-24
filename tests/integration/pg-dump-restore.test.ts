import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PgDumpResult } from '@/worker/jobs/pg-dump';
import {
  calDaysOut,
  type IntegrationContext,
  setupIntegration,
  teardownIntegration,
} from './helpers';
import { startPostgres } from './setup';

// Backups are the only recovery path, and nothing else proves a dump can be
// restored with the hand-written SQL that `prisma migrate diff` cannot
// regenerate (CLAUDE.md § Migrations carry SQL that Prisma cannot regenerate).
//
// Runs the REAL handlePgDump -- real pg_dump / pg_restore from PATH, the same
// way the worker does -- against a migrated + seeded source, restores the
// result into a SECOND, fresh Postgres with the runbook's flags
// (docs/backups.md), and compares the two.
//
// pg_dump / pg_restore come from the host, not the container, because that is
// the code path production runs (execFile on PATH, PGPASSWORD, a TCP URL).
// They must be >= the server major (18): the ubuntu-26.04 runner image ships
// PostgreSQL 18.6; on macOS, Homebrew's libpq (keg-only) or postgresql@18
// provides them. The preflight below fails with that hint instead of a
// pg_dump "server version mismatch".

// Only the fields handlePgDump reads. An unmocked getEnv() passes locally via
// .env and fails in CI, which has no .env.
vi.mock('@/lib/env', () => ({
  getEnv: () => ({ DATABASE_URL: process.env.DATABASE_URL, BACKUP_HEARTBEAT_URL: undefined }),
}));

// The runbook's pg_restore flags. Keep in step with docs/backups.md § Restoring.
const RESTORE_FLAGS = ['--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction'];

// Every hand-written object the migrations add with raw SQL.
const HAND_WRITTEN_CHECKS = [
  'Attachment_file_metadata_required',
  'Attachment_storage_xor_link',
  'service_record_targets_parent_xor',
  'warranty_targets_parent_xor',
  'reminder_targets_parent_at_most_one',
  'IncomingEmailTarget_parent_xor',
  'item_vendors_link_xor',
  'system_vendors_link_xor',
  'part_links_parent_xor',
];
const NULLS_NOT_DISTINCT_INDEXES = [
  'sr_targets_record_item_system_part_key',
  'warranty_targets_warrantyId_itemId_systemId_key',
  'reminder_targets_reminder_item_system_part_key',
  'incoming_email_targets_incomingEmailId_itemId_systemId_key',
  'part_links_partId_itemId_systemId_key',
];
const IVFFLAT_INDEX = 'embeddings_embedding_cosine_idx';
// A queue that exists only in this test, so finding it after the restore can
// only mean the dump carried pg-boss's schema.
const PROBE_QUEUE = 'backup-restore-probe';

let ctx: IntegrationContext;
let target: StartedPostgreSqlContainer;
let backupDir: string;
let result: PgDumpResult;
let source: Client;
let restored: Client;

function clientMajor(bin: 'pg_dump' | 'pg_restore'): number {
  let out: string;
  try {
    out = execFileSync(bin, ['--version'], { encoding: 'utf8' });
  } catch {
    throw new Error(
      `${bin} is not on PATH. Install a PostgreSQL 18+ client -- on macOS, \`brew install libpq\` and put "$(brew --prefix libpq)/bin" on PATH (libpq is keg-only).`,
    );
  }
  const m = /\(PostgreSQL\)\s+(\d+)/.exec(out);
  if (!m) throw new Error(`cannot parse \`${bin} --version\`: ${out}`);
  return Number(m[1]);
}

async function seedRepresentativeRows(): Promise<void> {
  const p = ctx.prisma;
  const user = await p.user.create({
    data: { email: 'backup-restore@example.com', name: 'Backup Restore' },
  });
  const category = await p.category.findUniqueOrThrow({ where: { slug: 'plumbing' } });
  // From prisma/seed.ts, which also seeded three parts and two part_links.
  const systemId = 'seed-system-hvac';
  const item = await p.item.create({
    data: {
      name: 'Water heater',
      categoryId: category.id,
      systemId,
      purchaseDate: calDaysOut(-400),
      purchasePrice: '1299.00',
      metadata: { capacityGallons: 50 },
    },
  });
  const vendor = await p.vendor.create({ data: { name: 'Acme Plumbing', tags: ['plumbing'] } });

  // item_vendors_link_xor / system_vendors_link_xor: both arms.
  await p.itemVendor.create({ data: { itemId: item.id, vendorId: vendor.id, role: 'INSTALLER' } });
  await p.itemVendor.create({
    data: { itemId: item.id, freeformName: 'Previous owner', role: 'PURCHASE' },
  });
  await p.systemVendor.create({
    data: {
      systemId,
      vendorId: vendor.id,
      role: 'SERVICE',
      serviceContract: true,
      contractEndsOn: calDaysOut(200),
    },
  });

  await p.warranty.create({
    data: {
      provider: 'Rheem',
      startsOn: calDaysOut(-400),
      endsOn: calDaysOut(2000),
      targets: { create: [{ itemId: item.id }, { systemId }] },
    },
  });

  // service_record_targets: all three parent arms.
  await p.serviceRecord.create({
    data: {
      summary: 'Annual flush',
      performedOn: calDaysOut(-30),
      vendorId: vendor.id,
      cost: '149.00',
      targets: {
        create: [{ itemId: item.id }, { systemId }, { partId: 'seed-part-air-filter' }],
      },
    },
  });

  // reminder_targets: a linked REMINDER, and a standalone CHORE's both-NULL row
  // (the relaxed "at most one" constraint).
  await p.reminder.create({
    data: {
      title: 'Flush water heater',
      recurrence: { kind: 'interval', every: 1, unit: 'year' },
      notifyUserIds: [user.id],
      targets: { create: [{ itemId: item.id, nextDueOn: calDaysOut(335) }] },
    },
  });
  await p.reminder.create({
    data: {
      title: 'Clean gutters',
      kind: 'CHORE',
      recurrence: { kind: 'interval', every: 6, unit: 'month' },
      notifyUserIds: [],
      targets: { create: [{ nextDueOn: calDaysOut(14) }] },
    },
  });

  // Attachment_storage_xor_link + Attachment_file_metadata_required: a stored
  // file and an external link.
  await p.attachment.create({
    data: {
      filename: 'manual.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1234,
      storagePath: 'backup-test/original.pdf',
      uploadedById: user.id,
      itemId: item.id,
    },
  });
  await p.attachment.create({
    data: {
      externalUrl: 'https://example.com/manual',
      displayLabel: 'Online manual',
      uploadedById: user.id,
      itemId: item.id,
    },
  });

  // A real vector(1024), so the restore has to rebuild the IVFFlat index over data.
  const vec = `[${Array.from({ length: 1024 }, (_, i) => ((i % 7) / 10).toFixed(1)).join(',')}]`;
  await p.$executeRaw`
    INSERT INTO embeddings (id, "entityType", "entityId", "chunkIndex", text, embedding, "tokenCount", "contentHash", "createdAt")
    VALUES (${randomUUID()}, 'ITEM'::"EmbeddingEntityType", ${item.id}, 0, 'Water heater', ${vec}::vector(1024), 3, 'backup-test', NOW())
  `;
}

/** Row count + content hash of every base table in `public`, keyed by table. */
async function tableFingerprints(db: Client): Promise<Record<string, string>> {
  const { rows: tables } = await db.query<{ t: string }>(
    `SELECT table_name AS t FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`,
  );
  const out: Record<string, string> = {};
  for (const { t } of tables) {
    const quoted = `"public"."${t.replace(/"/g, '""')}"`;
    const { rows } = await db.query<{ n: string; h: string | null }>(
      `SELECT count(*)::text AS n, md5(string_agg(x::text, E'\\n' ORDER BY x::text)) AS h FROM ${quoted} x`,
    );
    out[t] = `${rows[0].n}:${rows[0].h ?? 'empty'}`;
  }
  return out;
}

async function checkConstraints(db: Client) {
  const { rows } = await db.query<{ tbl: string; conname: string; def: string }>(
    `SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def
     FROM pg_constraint
     WHERE contype = 'c' AND connamespace = 'public'::regnamespace
     ORDER BY 1, 2`,
  );
  return rows;
}

async function indexes(db: Client) {
  const { rows } = await db.query<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`,
  );
  return rows;
}

beforeAll(async () => {
  ctx = await setupIntegration();
  execFileSync('pnpm', ['exec', 'tsx', 'prisma/seed.ts'], {
    env: { ...process.env, DATABASE_URL: ctx.stack.databaseUrl },
    stdio: 'inherit',
  });
  await seedRepresentativeRows();

  // pg-boss keeps its queues, jobs and cron schedules in a `pgboss` schema in
  // the same database, so a restore has to carry that too. Stopped before the
  // dump, and in `finally`, so no instance outlives this hook.
  const boss = new PgBoss({ connectionString: ctx.stack.databaseUrl });
  try {
    await boss.start();
    await boss.createQueue(PROBE_QUEUE);
  } finally {
    await boss.stop();
  }

  source = new Client({ connectionString: ctx.stack.databaseUrl });
  await source.connect();
  const { rows } = await source.query<{ v: string }>('SHOW server_version_num');
  const serverMajor = Math.floor(Number(rows[0].v) / 10_000);
  for (const bin of ['pg_dump', 'pg_restore'] as const) {
    const major = clientMajor(bin);
    if (major < serverMajor) {
      throw new Error(`${bin} ${major} on PATH cannot handle a PostgreSQL ${serverMajor} server.`);
    }
  }

  backupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-dump-restore-'));
  const { handlePgDump } = await import('@/worker/jobs/pg-dump');
  result = await handlePgDump({ backupDir });

  target = await startPostgres();
  // Archive on stdin, exactly as the runbook's `docker exec -i … < "$DUMP"`
  // feeds it. A custom-format archive restores from a non-seekable input only
  // in archive order, so this also proves the runbook's pipe works.
  execFileSync('pg_restore', [...RESTORE_FLAGS, `--dbname=${target.getConnectionUri()}`], {
    input: await fs.readFile(path.join(backupDir, result.file)),
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  restored = new Client({ connectionString: target.getConnectionUri() });
  await restored.connect();
}, 300_000);

afterAll(async () => {
  await restored?.end();
  await source?.end();
  await target?.stop();
  if (backupDir) await fs.rm(backupDir, { recursive: true, force: true });
  await teardownIntegration(ctx);
});

describe('pg_dump → pg_restore round-trip', () => {
  it('the job leaves exactly one validated dump and no temp file', async () => {
    expect(await fs.readdir(backupDir)).toEqual([result.file]);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.heartbeat).toBe('skipped');
  });

  it('every table has identical rows', async () => {
    const before = await tableFingerprints(source);
    // Not vacuous: the tables the hand-written SQL guards actually hold rows.
    for (const t of [
      'items',
      'item_vendors',
      'warranty_targets',
      'service_record_targets',
      'reminder_targets',
      'attachments',
      'part_links',
      'embeddings',
      '_prisma_migrations',
    ]) {
      expect(before[t], t).not.toMatch(/^0:/);
    }
    expect(await tableFingerprints(restored)).toEqual(before);
  });

  it('every CHECK constraint survives, including the hand-written ones', async () => {
    const before = await checkConstraints(source);
    const after = await checkConstraints(restored);
    expect(after).toEqual(before);
    const names = after.map((r) => r.conname);
    for (const c of HAND_WRITTEN_CHECKS) expect(names, c).toContain(c);
  });

  it('every index survives, including NULLS NOT DISTINCT and IVFFlat', async () => {
    const before = await indexes(source);
    const after = await indexes(restored);
    expect(after).toEqual(before);
    const byName = new Map(after.map((r) => [r.indexname, r.indexdef]));
    for (const name of NULLS_NOT_DISTINCT_INDEXES) {
      expect(byName.get(name), name).toMatch(/NULLS NOT DISTINCT/);
    }
    expect(byName.get(IVFFLAT_INDEX)).toMatch(/USING ivfflat/);
  });

  it("pg-boss's schema and queues survive", async () => {
    const tables = `SELECT tablename FROM pg_tables WHERE schemaname = 'pgboss' ORDER BY 1`;
    const before = (await source.query(tables)).rows;
    expect(before.length).toBeGreaterThan(0);
    expect((await restored.query(tables)).rows).toEqual(before);
    const probe = await restored.query('SELECT name FROM pgboss.queue WHERE name = $1', [
      PROBE_QUEUE,
    ]);
    expect(probe.rows).toHaveLength(1);
  });

  it('the vector extension is installed', async () => {
    const { rows } = await restored.query(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`);
    expect(rows).toHaveLength(1);
  });

  it('prisma sees the restored database as fully migrated', () => {
    // Web runs `migrate deploy` on boot after a restore. It must be a no-op.
    // `migrate status` exits non-zero when anything is pending or failed.
    expect(() =>
      execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'status'], {
        env: { ...process.env, DATABASE_URL: target.getConnectionUri() },
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });
});
