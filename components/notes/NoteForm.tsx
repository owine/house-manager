'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Controller, FormProvider, useForm } from 'react-hook-form';
import type { z } from 'zod';
import { ErrorBanner } from '@/components/forms/ErrorBanner';
import { FormField } from '@/components/forms/FormField';
import { SubmitButton } from '@/components/forms/SubmitButton';
import { ItemAutocomplete } from '@/components/service-records/ItemAutocomplete';
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

  const methods = useForm<NoteFormValues>({
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
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors },
  } = methods;

  const formError = (errors as { root?: { message?: string } }).root?.message;

  const onSubmit = handleSubmit((data) => {
    startTransition(async () => {
      const payload = defaultValues?.id ? { ...data, id: defaultValues.id } : data;
      const result = await action(payload as unknown as CreateNoteInput);
      if (!result.ok) {
        if (result.formError) setError('root', { message: result.formError });
        if (result.fieldErrors) {
          for (const [field, msgs] of Object.entries(result.fieldErrors)) {
            setError(field as Parameters<typeof setError>[0], { message: msgs?.[0] });
          }
        }
        return;
      }
      router.push(`/notes/${result.data.id}`);
    });
  });

  return (
    <FormProvider {...methods}>
      <form onSubmit={onSubmit} style={{ maxWidth: 900 }}>
        <ErrorBanner message={formError} />

        {/* Title */}
        <FormField label="Title" htmlFor="title" error={errors.title?.message}>
          <input
            id="title"
            {...register('title')}
            required
            style={{
              width: '100%',
              padding: '0.3rem 0.5rem',
              border: '1px solid var(--border-strong)',
              borderRadius: '4px',
            }}
          />
        </FormField>

        {/* Item autocomplete */}
        <ItemAutocomplete name="itemId" label="Attach to item (optional)" options={items} />

        {/* Tags */}
        <FormField
          label="Tags (comma-separated)"
          htmlFor="tags"
          error={errors.tags?.message as string | undefined}
        >
          <Controller
            control={control}
            name="tags"
            render={({ field }) => (
              <input
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
                style={{
                  width: '100%',
                  padding: '0.3rem 0.5rem',
                  border: '1px solid var(--border-strong)',
                  borderRadius: '4px',
                }}
              />
            )}
          />
        </FormField>

        {/* Body (markdown editor with live preview) */}
        <div style={{ marginBottom: '0.25rem', fontWeight: 500 }}>Body</div>
        <NoteEditor />

        <SubmitButton>{pending ? 'Saving…' : submitLabel}</SubmitButton>
      </form>
    </FormProvider>
  );
}
