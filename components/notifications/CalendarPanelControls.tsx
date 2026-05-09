'use client';
import { Check, Copy, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
    <div className="flex items-stretch gap-2">
      <Input type="text" readOnly value={url} className="flex-1 font-mono text-sm" />
      <Button type="button" variant="outline" onClick={handleCopy}>
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        {copied ? 'Copied!' : 'Copy'}
      </Button>
      <Button type="button" variant="outline" onClick={handleRegenerate} disabled={regenerating}>
        <RefreshCw className={regenerating ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
        {regenerating ? 'Regenerating…' : 'Regenerate'}
      </Button>
    </div>
  );
}
