'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { ItemAutocomplete } from '@/components/service-records/ItemAutocomplete';
import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { applyActionFieldErrors } from '@/lib/forms/helpers';
import { type CreateNoteInput, createNoteSchema } from '@/lib/notes/schema';
import type { ActionResult } from '@/lib/result';
import { NoteEditor } from './NoteEditor';

// Use z.input so tags (which has .default([])) stays as string[] | undefined in form state.
type NoteFormValues = z.input<typeof createNoteSchema>;

type Props = {
  items: { id: string; name: string }[];
  defaultValues?: Partial<CreateNoteInput & { id: string }>;
  action: (
    input: CreateNoteInput | (CreateNoteInput & { id: string }),
  ) => Promise<ActionResult<{ id: string }>>;
  submitLabel: string;
};

export function NoteForm({ items, defaultValues, action, submitLabel }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const form = useForm<NoteFormValues>({
    resolver: zodResolver(createNoteSchema),
    defaultValues: {
      title: '',
      body: '',
      itemId: undefined,
      tags: [],
      ...defaultValues,
    },
  });

  const {
    control,
    handleSubmit,
    setError,
    formState: { errors },
  } = form;

  const formError = (errors as { root?: { message?: string } }).root?.message;

  const onSubmit = handleSubmit((data) => {
    startTransition(async () => {
      const payload = defaultValues?.id ? { ...data, id: defaultValues.id } : data;
      const result = await action(payload as unknown as CreateNoteInput);
      if (!result.ok) {
        const applied = applyActionFieldErrors(setError, result);
        if (result.formError) setError('root', { message: result.formError });
        if (!applied && !result.formError) toast.error('Failed to save note');
        return;
      }
      const isEdit = !!defaultValues?.id;
      toast.success(isEdit ? 'Note updated' : 'Note created');
      router.push(`/notes/${result.data.id}`);
    });
  });

  return (
    <Form {...form}>
      <form onSubmit={onSubmit} className="space-y-6">
        {formError && (
          <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            {formError}
          </p>
        )}

        {/* Title */}
        <FormField
          control={control}
          name="title"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Title</FormLabel>
              <FormControl>
                <Input {...field} required />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Item autocomplete */}
        <FormField
          control={control}
          name="itemId"
          render={() => (
            <FormItem>
              <FormLabel>Attach to item (optional)</FormLabel>
              <FormControl>
                <ItemAutocomplete name="itemId" label="" options={items} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Tags */}
        <FormField
          control={control}
          name="tags"
          render={() => (
            <FormItem>
              <FormLabel>Tags (comma-separated)</FormLabel>
              <FormControl>
                <Controller
                  control={control}
                  name="tags"
                  render={({ field }) => (
                    <Input
                      id="tags"
                      defaultValue={(field.value ?? []).join(', ')}
                      onChange={(e) =>
                        field.onChange(
                          e.target.value
                            .split(',')
                            .map((t) => t.trim())
                            .filter(Boolean),
                        )
                      }
                    />
                  )}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Body (markdown editor with live preview) */}
        <NoteEditor />

        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : submitLabel}
        </Button>
      </form>
    </Form>
  );
}
