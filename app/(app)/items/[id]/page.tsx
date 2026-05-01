import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AttachmentList } from '@/components/attachments/AttachmentList';
import { AttachmentUploader } from '@/components/attachments/AttachmentUploader';
import { ItemTabs, type TabSlug } from '@/components/items/ItemTabs';
import { WarrantyTable } from '@/components/warranties/WarrantyTable';
import { archiveItem, restoreItem } from '@/lib/items/actions';
import { getItem } from '@/lib/items/queries';
import { Markdown } from '@/lib/markdown';

type Params = Promise<{ id: string }>;
type SearchParams = Promise<{ tab?: string }>;

const VALID_TABS: TabSlug[] = ['overview', 'warranties', 'service', 'notes', 'files', 'reminders'];

function parseTab(raw: string | undefined): TabSlug {
  if (raw && (VALID_TABS as string[]).includes(raw)) return raw as TabSlug;
  return 'overview';
}

/**
 * Convert a camelCase key to a human-readable label.
 * All-lowercase keys of 2–4 chars (btu, vin, seer) are uppercased entirely.
 */
function toLabel(key: string): string {
  if (/^[a-z]{2,4}$/.test(key)) return key.toUpperCase();
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

function stringifyMetaValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

const currencyFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
});

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

  const isArchived = item.archivedAt !== null;
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
    <div>
      {/* Header */}
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: '1rem',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            <h1 style={{ margin: 0 }}>{item.name}</h1>
            <span className="badge-sm" style={{ whiteSpace: 'nowrap' }}>
              {item.category.icon ? `${item.category.icon} ` : ''}
              {item.category.name}
            </span>
            {isArchived && (
              <span
                style={{
                  padding: '0.1rem 0.5rem',
                  background: 'var(--danger-bg)',
                  color: 'var(--danger)',
                  borderRadius: '4px',
                  fontSize: '0.8rem',
                  whiteSpace: 'nowrap',
                }}
              >
                Archived on {item.archivedAt?.toISOString().slice(0, 10)}
              </span>
            )}
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexShrink: 0 }}>
          <Link href={`/items/${item.id}/edit`}>Edit</Link>
          {isArchived ? (
            <form action={doRestore}>
              <button
                type="submit"
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  color: 'inherit',
                  font: 'inherit',
                }}
              >
                Restore
              </button>
            </form>
          ) : (
            <form action={doArchive}>
              <button
                type="submit"
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  color: 'var(--danger)',
                  font: 'inherit',
                }}
              >
                Archive
              </button>
            </form>
          )}
        </div>
      </header>

      {/* Tab navigation */}
      <ItemTabs active={tab} itemId={item.id} />

      {/* Tab bodies */}
      {tab === 'overview' && (
        <div>
          <dl
            style={{
              display: 'grid',
              gridTemplateColumns: 'max-content 1fr',
              gap: '0.4rem 1.5rem',
              marginBottom: '1.5rem',
            }}
          >
            {item.location && (
              <>
                <dt style={{ fontWeight: 600 }}>Location</dt>
                <dd style={{ margin: 0 }}>{item.location}</dd>
              </>
            )}
            {item.manufacturer && (
              <>
                <dt style={{ fontWeight: 600 }}>Manufacturer</dt>
                <dd style={{ margin: 0 }}>{item.manufacturer}</dd>
              </>
            )}
            {item.model && (
              <>
                <dt style={{ fontWeight: 600 }}>Model</dt>
                <dd style={{ margin: 0 }}>{item.model}</dd>
              </>
            )}
            {item.serialNumber && (
              <>
                <dt style={{ fontWeight: 600 }}>Serial number</dt>
                <dd style={{ margin: 0 }}>{item.serialNumber}</dd>
              </>
            )}
            {item.purchaseDate && (
              <>
                <dt style={{ fontWeight: 600 }}>Purchase date</dt>
                <dd style={{ margin: 0 }}>{item.purchaseDate.toISOString().slice(0, 10)}</dd>
              </>
            )}
            {item.purchasePrice !== null && item.purchasePrice !== undefined && (
              <>
                <dt style={{ fontWeight: 600 }}>Purchase price</dt>
                <dd style={{ margin: 0 }}>{currencyFmt.format(Number(item.purchasePrice))}</dd>
              </>
            )}
          </dl>

          {/* Metadata */}
          {item.metadata &&
            typeof item.metadata === 'object' &&
            Object.keys(item.metadata).length > 0 && (
              <section style={{ marginBottom: '1.5rem' }}>
                <h2 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>Details</h2>
                <dl
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'max-content 1fr',
                    gap: '0.4rem 1.5rem',
                  }}
                >
                  {Object.entries(item.metadata as Record<string, unknown>).map(([key, value]) => {
                    const displayValue = stringifyMetaValue(value);
                    if (!displayValue) return null;
                    return (
                      <>
                        <dt key={`${key}-dt`} style={{ fontWeight: 600 }}>
                          {toLabel(key)}
                        </dt>
                        <dd key={`${key}-dd`} style={{ margin: 0 }}>
                          {displayValue}
                        </dd>
                      </>
                    );
                  })}
                </dl>
              </section>
            )}

          {/* Freeform notes */}
          {item.notes && (
            <section>
              <h2 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>Notes</h2>
              <Markdown>{item.notes}</Markdown>
            </section>
          )}
        </div>
      )}

      {tab === 'warranties' && (
        <div>
          <header
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '0.75rem',
            }}
          >
            <h2 style={{ fontSize: '1rem', margin: 0 }}>Warranties</h2>
            <Link href={`/items/${item.id}/warranties/new`}>+ Add warranty</Link>
          </header>
          {item.warranties.length === 0 ? (
            <p>No warranties yet.</p>
          ) : (
            <WarrantyTable warranties={item.warranties} />
          )}
        </div>
      )}

      {tab === 'service' && (
        <div>
          <header
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '0.75rem',
            }}
          >
            <h2 style={{ fontSize: '1rem', margin: 0 }}>Service history</h2>
            <Link href={`/service/new?itemId=${item.id}`}>+ Log service</Link>
          </header>
          {item.serviceRecords.length === 0 ? (
            <p>No service records yet.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr className="table-header">
                  <th className="table-cell">Date</th>
                  <th className="table-cell">Summary</th>
                  <th className="table-cell">Vendor</th>
                  <th className="table-cell">Cost</th>
                </tr>
              </thead>
              <tbody>
                {item.serviceRecords.map((sr) => (
                  <tr key={sr.id} className="table-row">
                    <td className="table-cell">
                      <Link href={`/service/${sr.id}`}>
                        {sr.performedOn.toISOString().slice(0, 10)}
                      </Link>
                    </td>
                    <td className="table-cell">{sr.summary}</td>
                    <td className="table-cell">
                      {sr.vendor ? (
                        <Link href={`/vendors/${sr.vendor.id}`}>{sr.vendor.name}</Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="table-cell">
                      {sr.cost ? currencyFmt.format(sr.cost.toNumber()) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'notes' && (
        <div>
          <header
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '0.75rem',
            }}
          >
            <h2 style={{ fontSize: '1rem', margin: 0 }}>Notes</h2>
            <Link href={`/notes/new?itemId=${item.id}`}>+ Add note</Link>
          </header>
          {item.itemNotes.length === 0 ? (
            <p>No notes yet.</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {item.itemNotes.map((note) => (
                <li
                  key={note.id}
                  style={{ borderBottom: '1px solid var(--border)', padding: '0.5rem 0' }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Link href={`/notes/${note.id}`} style={{ fontWeight: 500 }}>
                      {note.title}
                    </Link>
                    <span style={{ color: 'var(--fg-muted)', fontSize: '0.85rem' }}>
                      {note.updatedAt.toISOString().slice(0, 10)}
                    </span>
                  </div>
                  {note.tags.length > 0 && (
                    <div style={{ marginTop: '0.25rem' }}>
                      {note.tags.map((t) => (
                        <span key={t} className="badge-sm" style={{ marginRight: '0.25rem' }}>
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === 'files' && (
        <div>
          <header
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '0.75rem',
            }}
          >
            <h2 style={{ fontSize: '1rem', margin: 0 }}>Files</h2>
          </header>
          <AttachmentList attachments={item.attachments} />
          <AttachmentUploader parentType="item" parentId={item.id} />
        </div>
      )}

      {tab === 'reminders' && (
        <div>
          <header
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '0.75rem',
            }}
          >
            <h2 style={{ fontSize: '1rem', margin: 0 }}>Reminders</h2>
            <Link href={`/reminders/new?itemId=${item.id}`}>+ Add reminder</Link>
          </header>
          {item.reminders.length === 0 ? (
            <p>No reminders yet.</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {item.reminders.map((r) => (
                <li
                  key={r.id}
                  style={{
                    borderBottom: '1px solid var(--border)',
                    padding: '0.5rem 0',
                    display: 'flex',
                    justifyContent: 'space-between',
                  }}
                >
                  <Link href={`/reminders/${r.id}`}>{r.title}</Link>
                  <span style={{ color: 'var(--fg-muted)', fontSize: '0.85rem' }}>
                    {r.nextDueOn.toISOString().slice(0, 10)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
