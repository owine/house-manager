import type { Metadata } from 'next';
import Link from 'next/link';
import { ListPageShell } from '@/app/(app)/_components/ListPageShell';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { InboxList } from '@/components/incoming-email/InboxList';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { type InboxTab, listInboxEmails } from '@/lib/incoming-email/queries';

export const metadata: Metadata = { title: 'inbox' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function isInboxTab(v: unknown): v is InboxTab {
  return v === 'untriaged' || v === 'archived';
}

export default async function InboxPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const tab: InboxTab = isInboxTab(sp.tab) ? sp.tab : 'untriaged';
  const rows = await listInboxEmails({ tab });

  return (
    <ListPageShell
      header={
        <PageHeader
          title="inbox"
          description="Vendor estimates, invoices, and service tickets forwarded via email."
        />
      }
      filters={
        <Tabs value={tab}>
          <TabsList>
            <TabsTrigger value="untriaged" render={<Link href="/inbox?tab=untriaged" />}>
              Untriaged
            </TabsTrigger>
            <TabsTrigger value="archived" render={<Link href="/inbox?tab=archived" />}>
              Archived
            </TabsTrigger>
          </TabsList>
        </Tabs>
      }
    >
      <InboxList rows={rows} />
    </ListPageShell>
  );
}
