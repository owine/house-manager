import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AttachmentList } from '@/components/attachments/AttachmentList';
import { AttachmentUploader } from '@/components/attachments/AttachmentUploader';
import { WarrantyStatusBadge } from '@/components/warranties/WarrantyStatusBadge';
import { getWarranty } from '@/lib/warranties/queries';

const currencyFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
});

type Params = Promise<{ id: string }>;

export default async function WarrantyDetailPage({ params }: { params: Params }) {
  const { id } = await params;
  const warranty = await getWarranty(id);
  if (!warranty) notFound();

  return (
    <div>
      <header style={{ marginBottom: '1rem' }}>
        <h1 style={{ margin: 0 }}>{warranty.provider}</h1>
        <div
          style={{
            display: 'flex',
            gap: '0.75rem',
            alignItems: 'center',
            marginTop: '0.25rem',
          }}
        >
          <WarrantyStatusBadge endsOn={warranty.endsOn} />
          {warranty.item && (
            <span style={{ fontSize: '0.85rem' }}>
              for <Link href={`/items/${warranty.item.id}`}>{warranty.item.name}</Link>
            </span>
          )}
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
        {warranty.policyNumber && (
          <>
            <dt style={{ fontWeight: 600 }}>Policy #</dt>
            <dd style={{ margin: 0 }}>{warranty.policyNumber}</dd>
          </>
        )}
        <dt style={{ fontWeight: 600 }}>Starts on</dt>
        <dd style={{ margin: 0 }}>{warranty.startsOn.toISOString().slice(0, 10)}</dd>
        <dt style={{ fontWeight: 600 }}>Ends on</dt>
        <dd style={{ margin: 0 }}>{warranty.endsOn.toISOString().slice(0, 10)}</dd>
        {warranty.cost != null && (
          <>
            <dt style={{ fontWeight: 600 }}>Cost</dt>
            <dd style={{ margin: 0 }}>{currencyFmt.format(warranty.cost.toNumber())}</dd>
          </>
        )}
      </dl>

      {warranty.coverage && (
        <section style={{ marginBottom: '1.5rem' }}>
          <h2 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>Coverage</h2>
          <p style={{ whiteSpace: 'pre-wrap' }}>{warranty.coverage}</p>
        </section>
      )}

      <section>
        <h2 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>Files</h2>
        <AttachmentList attachments={warranty.attachments} />
        <AttachmentUploader parentType="warranty" parentId={warranty.id} />
      </section>
    </div>
  );
}
