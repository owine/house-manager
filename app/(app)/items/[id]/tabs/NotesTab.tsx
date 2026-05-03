import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { getItem } from '@/lib/items/queries';

type Item = NonNullable<Awaited<ReturnType<typeof getItem>>>;

type Props = { item: Item };

export function NotesTab({ item }: Props) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between border-b pb-3">
        <CardTitle>Notes</CardTitle>
        <Button variant="outline" size="sm" render={<Link href={`/notes/new?itemId=${item.id}`} />}>
          + Add note
        </Button>
      </CardHeader>
      <CardContent className="pt-4">
        {item.itemNotes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No notes yet.</p>
        ) : (
          <ul className="divide-y">
            {item.itemNotes.map((note) => (
              <li key={note.id} className="py-3">
                <div className="flex items-center justify-between gap-2">
                  <Link
                    href={`/notes/${note.id}`}
                    className="text-sm font-medium underline-offset-4 hover:underline"
                  >
                    {note.title}
                  </Link>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {note.updatedAt.toISOString().slice(0, 10)}
                  </span>
                </div>
                {note.tags.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {note.tags.map((t) => (
                      <Badge key={t} variant="secondary">
                        {t}
                      </Badge>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
