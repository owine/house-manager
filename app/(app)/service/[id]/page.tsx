import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { AttachmentList } from '@/components/attachments/AttachmentList';
import { AttachmentUploader } from '@/components/attachments/AttachmentUploader';
import { Markdown } from '@/lib/markdown';
import { deleteServiceRecord } from '@/lib/service-records/actions';
import { getServiceRecord } from '@/lib/service-records/queries';

type Params = Promise<{ id: string }>;

const currencyFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
});

export default async function ServiceRecordDetailPage({ params }: { params: Params }) {
  const { id } = await params;
  const record = await getServiceRecord(id);
  if (!record) notFound();

  const recordId = record.id;

  async function doDelete() {
    'use server';
    await deleteServiceRecord(recordId);
    redirect('/service');
  }

  return (
    <div>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: '1.5rem',
        }}
      >
        <div>
          <p style={{ margin: '0 0 0.25rem', fontSize: '0.85rem', color: 'var(--fg-muted)' }}>
            <Link href="/service">Service records</Link>
          </p>
          <h1 style={{ margin: 0 }}>{record.summary}</h1>
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexShrink: 0 }}>
          <Link href={`/service/${record.id}/edit`}>Edit</Link>
          <form action={doDelete}>
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
              Delete
            </button>
          </form>
        </div>
      </header>

      <dl
        style={{
          display: 'grid',
          gridTemplateColumns: 'max-content 1fr',
          gap: '0.4rem 1.5rem',
          marginBottom: '1.5rem',
        }}
      >
        <dt style={{ fontWeight: 600 }}>Performed on</dt>
        <dd style={{ margin: 0 }}>{record.performedOn.toISOString().slice(0, 10)}</dd>

        {record.item && (
          <>
            <dt style={{ fontWeight: 600 }}>Item</dt>
            <dd style={{ margin: 0 }}>
              <Link href={`/items/${record.item.id}`}>{record.item.name}</Link>
            </dd>
          </>
        )}

        {record.vendor && (
          <>
            <dt style={{ fontWeight: 600 }}>Vendor</dt>
            <dd style={{ margin: 0 }}>
              <Link href={`/vendors/${record.vendor.id}`}>{record.vendor.name}</Link>
            </dd>
          </>
        )}

        {record.cost != null && (
          <>
            <dt style={{ fontWeight: 600 }}>Cost</dt>
            <dd style={{ margin: 0 }}>{currencyFmt.format(record.cost.toNumber())}</dd>
          </>
        )}
      </dl>

      {record.notes && (
        <section>
          <h2 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>Notes</h2>
          <Markdown>{record.notes}</Markdown>
        </section>
      )}

      <section style={{ marginTop: '1.5rem' }}>
        <h2 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>Files</h2>
        <AttachmentList attachments={record.attachments} />
        <AttachmentUploader parentType="serviceRecord" parentId={record.id} />
      </section>
    </div>
  );
}
