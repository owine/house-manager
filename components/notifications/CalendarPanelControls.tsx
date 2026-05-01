'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { regenerateIcsToken } from '@/lib/notifications/actions';

type Props = {
  url: string;
};

export function CalendarPanelControls({ url }: Props) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error('Failed to copy', e);
    }
  };

  const handleRegenerate = async () => {
    setRegenerating(true);
    try {
      await regenerateIcsToken();
      router.refresh();
    } catch (e) {
      console.error('Failed to regenerate', e);
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'stretch' }}>
      <input
        type="text"
        readOnly
        value={url}
        style={{
          flex: 1,
          padding: '0.5rem',
          fontFamily: 'monospace',
          fontSize: '0.85rem',
          border: '1px solid var(--border)',
          borderRadius: '4px',
        }}
      />
      <button
        type="button"
        onClick={handleCopy}
        style={{
          padding: '0.5rem 1rem',
          backgroundColor: 'transparent',
          border: '1px solid var(--border)',
          borderRadius: '4px',
          cursor: 'pointer',
        }}
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>
      <button
        type="button"
        onClick={handleRegenerate}
        disabled={regenerating}
        style={{
          padding: '0.5rem 1rem',
          backgroundColor: 'transparent',
          border: '1px solid var(--border)',
          borderRadius: '4px',
          cursor: 'pointer',
        }}
      >
        {regenerating ? 'Regenerating…' : 'Regenerate'}
      </button>
    </div>
  );
}
