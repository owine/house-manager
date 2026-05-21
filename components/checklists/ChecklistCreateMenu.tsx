'use client';
import { ChevronDown, Plus, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { SuggestionPreview } from '@/app/(app)/_components/SuggestionPreview';
import { ChecklistPromptDialog } from '@/components/checklists/ChecklistPromptDialog';
import { useChecklistSuggestion } from '@/components/checklists/useChecklistSuggestion';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function ChecklistCreateMenu() {
  const { pending, preview, generateSeasonal, generateFreeform, reset } = useChecklistSuggestion();
  const [promptOpen, setPromptOpen] = useState(false);

  return (
    <>
      <div className="flex items-center">
        <Button render={<Link href="/checklists/new" />} className="rounded-r-none">
          <Plus className="h-4 w-4" />
          New checklist
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button size="icon" aria-label="More create options" disabled={pending} />}
            className="rounded-l-none border-l border-l-primary-foreground/20"
          >
            <ChevronDown className="h-4 w-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setPromptOpen(true)}>
              <Sparkles className="h-4 w-4" />
              Generate from prompt
            </DropdownMenuItem>
            <DropdownMenuItem onClick={generateSeasonal}>
              <Sparkles className="h-4 w-4" />
              Generate seasonal
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <ChecklistPromptDialog
        open={promptOpen}
        onOpenChange={setPromptOpen}
        onSubmit={generateFreeform}
        pending={pending}
      />

      <Dialog open={preview !== null} onOpenChange={(o) => !o && reset()}>
        <DialogContent className="sm:max-w-lg">
          {preview && (
            <>
              <DialogHeader>
                <DialogTitle>{preview.name}</DialogTitle>
              </DialogHeader>
              {preview.description && (
                <p className="text-sm text-muted-foreground">{preview.description}</p>
              )}
              <SuggestionPreview
                kind="checklist"
                logId={preview.logId}
                name={preview.name}
                description={preview.description}
                items={preview.items}
                onSaved={reset}
                onDiscard={reset}
              />
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
