import { CheckCircle2 } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { FormPageShell } from '@/app/(app)/_components/FormPageShell';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { GenerateRemindersButton } from '@/components/ai/GenerateRemindersButton';
import { Button } from '@/components/ui/button';
import { prisma } from '@/lib/db';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const item = await prisma.item.findUnique({ where: { id }, select: { name: true } });
  return { title: item?.name ?? 'Not found' };
}

export default async function SuggestAfterCreate({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const item = await prisma.item.findUnique({
    where: { id },
    select: { id: true, name: true },
  });
  if (!item) notFound();

  return (
    <FormPageShell maxWidth="xl" header={<PageHeader title={item.name} />}>
      <div className="space-y-6">
        <div className="flex items-center gap-2 rounded-md border border-emerald-300 bg-emerald-50 p-4 text-sm dark:bg-emerald-950/30">
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          <span>Item saved</span>
        </div>

        <div className="space-y-2">
          <h2 className="text-lg font-semibold">Want maintenance reminders for {item.name}?</h2>
          <p className="text-sm text-muted-foreground">
            Claude will suggest a few based on what {item.name} is and where it's installed. You can
            edit or skip any of them before saving.
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <GenerateRemindersButton itemId={item.id} />
          <Button variant="outline" render={<Link href={`/items/${item.id}`} />}>
            Skip
          </Button>
        </div>
      </div>
    </FormPageShell>
  );
}
