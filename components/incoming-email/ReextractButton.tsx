'use client';

import { useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { reextractIncomingEmail } from '@/lib/incoming-email/actions';

export function ReextractButton({ emailId }: { emailId: string }) {
  const [pending, start] = useTransition();
  const onClick = () =>
    start(async () => {
      const r = await reextractIncomingEmail({ id: emailId });
      if (!r.ok) toast.error(r.formError ?? 'Failed to re-extract');
      else toast.success('Re-extract queued — refresh in a moment');
    });
  return (
    <Button variant="outline" size="sm" onClick={onClick} disabled={pending}>
      Re-extract
    </Button>
  );
}
