import { AttachmentList } from '@/components/attachments/AttachmentList';
import { AttachmentUploader } from '@/components/attachments/AttachmentUploader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { getPart } from '@/lib/parts/queries';

type Part = NonNullable<Awaited<ReturnType<typeof getPart>>>;

type Props = { part: Part };

export function FilesTab({ part }: Props) {
  return (
    <Card>
      <CardHeader className="border-b pb-3">
        <CardTitle>Files</CardTitle>
      </CardHeader>
      <CardContent className="pt-4">
        <AttachmentList attachments={part.attachments} />
        <AttachmentUploader parentType="part" parentId={part.id} />
      </CardContent>
    </Card>
  );
}
