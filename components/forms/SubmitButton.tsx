'use client';
import { useFormStatus } from 'react-dom';

export function SubmitButton({ children }: { children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} style={{ padding: '0.5rem 1rem' }}>
      {pending ? 'Saving…' : children}
    </button>
  );
}
