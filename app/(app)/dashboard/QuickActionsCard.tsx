import { NotebookPen, Plus, UserPlus, Wrench } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function QuickActionsCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Quick actions</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" render={<Link href="/items/new" />}>
            <Plus />
            Add item
          </Button>
          <Button variant="outline" render={<Link href="/service/new" />}>
            <Wrench />
            Log service
          </Button>
          <Button variant="outline" render={<Link href="/vendors/new" />}>
            <UserPlus />
            Add vendor
          </Button>
          <Button variant="outline" render={<Link href="/notes/new" />}>
            <NotebookPen />
            Add note
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
