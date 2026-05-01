'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
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
    <button
      type="button"
      onClick={handleClick}
      disabled={pending}
      style={{ padding: '0.5rem 1rem' }}
    >
      {pending ? 'Generating…' : 'Generate calendar URL'}
    </button>
  );
}
