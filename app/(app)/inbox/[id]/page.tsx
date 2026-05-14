import { Paperclip } from 'lucide-react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { EmailBodyView } from '@/components/incoming-email/EmailBodyView';
import { ExtractedFieldsCard } from '@/components/incoming-email/ExtractedFieldsCard';
import { InboxActionButtons, LinkPicker } from '@/components/incoming-email/LinkPicker';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LocalDate } from '@/components/ui/LocalDate';
import { Separator } from '@/components/ui/separator';
import {
  getInboxEmail,
  loadLinkPickerOptions,
  selectExtraction,
} from '@/lib/incoming-email/queries';

export const metadata: Metadata = { title: 'inbox — message' };

function formatBytes(n: number | null): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default async function InboxDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [email, options] = await Promise.all([getInboxEmail(id), loadLinkPickerOptions()]);
  if (!email) notFound();

  const senderLine = email.fromName
    ? `${email.fromName} <${email.fromAddress}>`
    : email.fromAddress;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title={email.subject || '(no subject)'} />
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span>{senderLine}</span>
        <span aria-hidden="true">·</span>
        <LocalDate iso={email.receivedAt.toISOString()} />
        <Badge variant="outline">{email.kind}</Badge>
        {email.state === 'AUTO_LINKED' && <Badge variant="secondary">Auto-linked</Badge>}
        {email.archivedAt && <Badge variant="outline">Archived</Badge>}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Message</CardTitle>
        </CardHeader>
        <CardContent>
          <EmailBodyView bodyText={email.bodyText} bodyHtml={email.bodyHtml} />
        </CardContent>
      </Card>

      {/* AI-extracted summary / cost / date / scope, populated by the
          extract worker for TICKET / INVOICE / ESTIMATE kinds. Used to
          seed the new ServiceRecord on Create. */}
      {(email.kind === 'TICKET' || email.kind === 'INVOICE' || email.kind === 'ESTIMATE') &&
        email.archivedAt === null && (
          <ExtractedFieldsCard
            emailId={email.id}
            extraction={selectExtraction(email)}
            canReextract={
              email.archivedAt === null &&
              (email.state === 'UNTRIAGED' ||
                email.state === 'AUTO_LINKED' ||
                email.state === 'LINKED')
            }
          />
        )}

      <Card>
        <CardHeader>
          <CardTitle>Link to</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <LinkPicker
            emailId={email.id}
            initialVendorId={email.vendorId}
            initialTargets={email.targets.map((t) => ({
              itemId: t.itemId,
              systemId: t.systemId,
            }))}
            vendors={options.vendors}
            items={options.items}
            systems={options.systems}
          />
          <Separator />
          <InboxActionButtons
            emailId={email.id}
            isArchived={email.archivedAt !== null}
            canCreateServiceRecord={email.vendorId !== null || email.targets.length > 0}
            canReclassify={
              email.archivedAt === null &&
              (email.state === 'UNTRIAGED' || email.state === 'AUTO_LINKED')
            }
            createdServiceRecordId={email.createdServiceRecord?.id ?? null}
          />
          {email.createdServiceRecord && (
            <p className="text-sm text-muted-foreground">
              A service record was created from this email:{' '}
              <span className="font-medium text-foreground">
                {email.createdServiceRecord.summary}
              </span>
            </p>
          )}
        </CardContent>
      </Card>

      {email.attachments.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Paperclip className="h-4 w-4" /> Attachments ({email.attachments.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {email.attachments.map((a) => (
                <li key={a.id} className="flex items-center justify-between py-2 text-sm">
                  <span className="truncate">{a.filename ?? '(unnamed)'}</span>
                  <span className="ml-3 shrink-0 text-xs text-muted-foreground">
                    {a.mimeType ?? 'application/octet-stream'} · {formatBytes(a.sizeBytes)}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
