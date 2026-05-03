import { AttachmentList } from '@/components/attachments/AttachmentList';
import { AttachmentUploader } from '@/components/attachments/AttachmentUploader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { getItem } from '@/lib/items/queries';

type Item = NonNullable<Awaited<ReturnType<typeof getItem>>>;

type Props = { item: Item };

export function FilesTab({ item }: Props) {
  return (
    <Card>
      <CardHeader className="border-b pb-3">
        <CardTitle>Files</CardTitle>
      </CardHeader>
      <CardContent className="pt-4">
        <AttachmentList attachments={item.attachments} />
        <AttachmentUploader parentType="item" parentId={item.id} />
      </CardContent>
    </Card>
  );
}
