'use client';
import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';

type Props = {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSubmit: (prompt: string) => void;
  pending: boolean;
};

export function ChecklistPromptDialog({ open, onOpenChange, onSubmit, pending }: Props) {
  const [prompt, setPrompt] = useState('');
  const trimmed = prompt.trim();

  function go(e: React.FormEvent) {
    e.preventDefault();
    if (trimmed.length < 3) return;
    onSubmit(trimmed);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Generate from prompt</DialogTitle>
          <DialogDescription>
            Describe what you want a checklist for — pre-vacation, snowstorm prep, end-of-month
            rentals — and Claude will draft items based on your inventory.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={go} className="space-y-3">
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. Pre-vacation checklist for a 2-week trip"
            maxLength={2000}
            rows={4}
          />
          <div className="flex justify-end">
            <Button type="submit" disabled={pending || trimmed.length < 3}>
              <Sparkles className="h-4 w-4" />
              {pending ? 'Thinking…' : 'Generate'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
