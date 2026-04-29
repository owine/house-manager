import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Markdown } from '@/lib/markdown';
import { getVendor } from '@/lib/vendors/queries';

type Params = Promise<{ id: string }>;

export default async function VendorDetailPage({ params }: { params: Params }) {
  const { id } = await params;
  const vendor = await getVendor(id);
  if (!vendor) notFound();

  return (
    <div>
      <header style={{ display: 'flex', justifyContent: 'space-between' }}>
        <h1>{vendor.name}</h1>
        <div>
          <Link href={`/vendors/${vendor.id}/edit`}>Edit</Link>
          {' · '}
          <Link href={`/service/new?vendorId=${vendor.id}`}>Log service</Link>
        </div>
      </header>
      <dl>
        {vendor.kind && (
          <>
            <dt>Kind</dt>
            <dd>{vendor.kind}</dd>
          </>
        )}
        {vendor.phone && (
          <>
            <dt>Phone</dt>
            <dd>{vendor.phone}</dd>
          </>
        )}
        {vendor.email && (
          <>
            <dt>Email</dt>
            <dd>{vendor.email}</dd>
          </>
        )}
        {vendor.website && (
          <>
            <dt>Website</dt>
            <dd>
              <a href={vendor.website}>{vendor.website}</a>
            </dd>
          </>
        )}
        {vendor.address && (
          <>
            <dt>Address</dt>
            <dd>{vendor.address}</dd>
          </>
        )}
      </dl>
      {vendor.tags.length > 0 && <p>Tags: {vendor.tags.join(', ')}</p>}
      {vendor.notes && (
        <section>
          <h2>Notes</h2>
          <Markdown>{vendor.notes}</Markdown>
        </section>
      )}
      <section>
        <h2>Service history</h2>
        {vendor.serviceRecords.length === 0 ? (
          <p>No service records yet.</p>
        ) : (
          <ul>
            {vendor.serviceRecords.map((sr) => (
              <li key={sr.id}>
                <Link href={`/service/${sr.id}`}>
                  {sr.performedOn.toISOString().slice(0, 10)} — {sr.summary}
                  {sr.item && ` (${sr.item.name})`}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
