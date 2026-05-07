import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { LocalDate } from '@/components/ui/LocalDate';

type NoteRow = {
  id: string;
  title: string;
  body: string;
  item: { id: string; name: string } | null;
  tags: string[];
  updatedAt: Date;
};

export function NoteCardGrid({ notes }: { notes: NoteRow[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {notes.map((note) => (
        <Card key={note.id} className="flex flex-col">
          <CardHeader>
            <CardTitle>
              <Link href={`/notes/${note.id}`} className="hover:underline">
                {note.title}
              </Link>
            </CardTitle>
            <CardDescription className="flex flex-wrap items-center gap-1.5">
              <span>
                <LocalDate iso={note.updatedAt.toISOString()} />
              </span>
              {note.item && (
                <>
                  <span className="text-muted-foreground/50">·</span>
                  <Link
                    href={`/items/${note.item.id}`}
                    className="underline underline-offset-2 hover:text-foreground"
                  >
                    {note.item.name}
                  </Link>
                </>
              )}
            </CardDescription>
          </CardHeader>
          {note.body && (
            <CardContent>
              <p className="line-clamp-3 text-sm text-muted-foreground">{note.body}</p>
            </CardContent>
          )}
          {note.tags.length > 0 && (
            <CardFooter className="mt-auto flex flex-wrap gap-1.5">
              {note.tags.map((tag) => (
                <Badge key={tag} variant="secondary">
                  {tag}
                </Badge>
              ))}
            </CardFooter>
          )}
        </Card>
      ))}
    </div>
  );
}
