'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Controller, useForm } from 'react-hook-form';
import type { z } from 'zod';
import { ErrorBanner } from '@/components/forms/ErrorBanner';
import { FormField } from '@/components/forms/FormField';
import { SubmitButton } from '@/components/forms/SubmitButton';
import type { ActionResult } from '@/lib/result';
import { type CreateVendorInput, createVendorSchema } from '@/lib/vendors/schema';

// Use the Zod input type so `tags` (which has .default([])) is string[] | undefined,
// matching what react-hook-form sends before the resolver transforms it.
type VendorFormValues = z.input<typeof createVendorSchema>;

type Props = {
  defaultValues?: Partial<CreateVendorInput & { id: string }>;
  action: (
    input: CreateVendorInput | (CreateVendorInput & { id: string }),
  ) => Promise<ActionResult<{ id: string }>>;
  submitLabel: string;
};

export function VendorForm({ defaultValues, action, submitLabel }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<VendorFormValues>({
    resolver: zodResolver(createVendorSchema),
    defaultValues: { tags: [], ...defaultValues },
  });
  const formError = (errors as { root?: { message?: string } }).root?.message;

  const onSubmit = handleSubmit((data) => {
    startTransition(async () => {
      const payload = defaultValues?.id ? { ...data, id: defaultValues.id } : data;
      const result = await action(payload as unknown as CreateVendorInput);
      if (!result.ok) {
        if (result.formError) setError('root', { message: result.formError });
        if (result.fieldErrors) {
          for (const [field, msgs] of Object.entries(result.fieldErrors)) {
            setError(field as keyof VendorFormValues, { message: msgs?.[0] });
          }
        }
        return;
      }
      router.push(`/vendors/${result.data.id}`);
    });
  });

  return (
    <form onSubmit={onSubmit} style={{ maxWidth: 600 }}>
      <ErrorBanner message={formError} />
      <FormField label="Name" htmlFor="name" error={errors.name?.message}>
        <input id="name" {...register('name')} required />
      </FormField>
      <FormField
        label="Kind"
        htmlFor="kind"
        error={errors.kind?.message}
        hint="e.g. plumber, hvac tech"
      >
        <input id="kind" {...register('kind')} />
      </FormField>
      <FormField label="Phone" htmlFor="phone" error={errors.phone?.message}>
        <input id="phone" {...register('phone')} />
      </FormField>
      <FormField label="Email" htmlFor="email" error={errors.email?.message}>
        <input id="email" type="email" {...register('email')} />
      </FormField>
      <FormField label="Website" htmlFor="website" error={errors.website?.message}>
        <input id="website" type="url" {...register('website')} />
      </FormField>
      <FormField label="Address" htmlFor="address" error={errors.address?.message}>
        <input id="address" {...register('address')} />
      </FormField>
      <FormField label="Notes (markdown)" htmlFor="notes" error={errors.notes?.message}>
        <textarea id="notes" rows={6} {...register('notes')} />
      </FormField>
      <FormField label="Tags (comma-separated)" htmlFor="tags" error={errors.tags?.message}>
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
            />
          )}
        />
      </FormField>
      <SubmitButton>{pending ? 'Saving…' : submitLabel}</SubmitButton>
    </form>
  );
}
