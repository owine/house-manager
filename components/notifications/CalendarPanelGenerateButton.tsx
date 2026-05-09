'use client';
import { Calendar, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { regenerateIcsToken } from '@/lib/notifications/actions';

export function CalendarPanelGenerateButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const handleClick = async () => {
    setPending(true);
    try {
      await regenerateIcsToken();
      router.refresh();
    } catch (e) {
      console.error('Failed to generate calendar URL', e);
    } finally {
      setPending(false);
    }
  };

  return (
    <Button type="button" variant="outline" onClick={handleClick} disabled={pending}>
      {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Calendar className="h-4 w-4" />}
      {pending ? 'Generating…' : 'Generate calendar URL'}
    </Button>
  );
}
