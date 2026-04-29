'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { FormProvider, useForm } from 'react-hook-form';
import type { z } from 'zod';
import { ErrorBanner } from '@/components/forms/ErrorBanner';
import { FormField } from '@/components/forms/FormField';
import { SubmitButton } from '@/components/forms/SubmitButton';
import { ItemAutocomplete } from '@/components/service-records/ItemAutocomplete';
import { VendorAutocomplete } from '@/components/service-records/VendorAutocomplete';
import type { ActionResult } from '@/lib/result';
import {
  type CreateServiceRecordInput,
  createServiceRecordSchema,
} from '@/lib/service-records/schema';

// Use z.input so performedOn stays as string in form state (resolver coerces via z.coerce.date)
type ServiceRecordFormValues = z.input<typeof createServiceRecordSchema>;

type Props = {
  items: { id: string; name: string }[];
  vendors: { id: string; name: string }[];
  defaultValues?: Partial<CreateServiceRecordInput & { id: string }>;
  action: (
    input: CreateServiceRecordInput | (CreateServiceRecordInput & { id: string }),
  ) => Promise<ActionResult<{ id: string }>>;
  submitLabel: string;
};

export function ServiceRecordForm({ items, vendors, defaultValues, action, submitLabel }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // Derive the string representation of performedOn for the date input
  const performedOnDefault = defaultValues?.performedOn
    ? defaultValues.performedOn instanceof Date
      ? defaultValues.performedOn.toISOString().slice(0, 10)
      : String(defaultValues.performedOn)
    : ('' as unknown as Date);

  const methods = useForm<ServiceRecordFormValues>({
    resolver: zodResolver(createServiceRecordSchema),
    defaultValues: {
      itemId: undefined,
      vendorId: undefined,
      cost: undefined,
      summary: '',
      notes: '',
      ...defaultValues,
      performedOn: performedOnDefault,
    },
  });

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = methods;

  const formError = (errors as { root?: { message?: string } }).root?.message;

  const onSubmit = handleSubmit((data) => {
    startTransition(async () => {
      const payload = defaultValues?.id ? { ...data, id: defaultValues.id } : data;
      const result = await action(payload as unknown as CreateServiceRecordInput);
      if (!result.ok) {
        if (result.formError) setError('root', { message: result.formError });
        if (result.fieldErrors) {
          for (const [field, msgs] of Object.entries(result.fieldErrors)) {
            setError(field as Parameters<typeof setError>[0], { message: msgs?.[0] });
          }
        }
        return;
      }
      router.push(`/service/${result.data.id}`);
    });
  });

  return (
    <FormProvider {...methods}>
      <form onSubmit={onSubmit} style={{ maxWidth: 600 }}>
        <ErrorBanner message={formError} />

        {/* Item autocomplete */}
        <ItemAutocomplete name="itemId" label="Item (optional)" options={items} />

        {/* Vendor autocomplete */}
        <VendorAutocomplete name="vendorId" label="Vendor (optional)" options={vendors} />

        <FormField label="Performed on" htmlFor="performedOn" error={errors.performedOn?.message}>
          <input id="performedOn" type="date" {...register('performedOn')} required />
        </FormField>

        <FormField label="Cost (USD)" htmlFor="cost" error={errors.cost?.message}>
          <input
            id="cost"
            type="number"
            step="0.01"
            min="0"
            {...register('cost', {
              setValueAs: (v) =>
                v === '' || v === null || v === undefined ? undefined : Number(v),
            })}
          />
        </FormField>

        <FormField label="Summary" htmlFor="summary" error={errors.summary?.message}>
          <input id="summary" {...register('summary')} required style={{ width: '100%' }} />
        </FormField>

        <FormField label="Notes (markdown)" htmlFor="notes" error={errors.notes?.message}>
          <textarea id="notes" rows={6} {...register('notes')} style={{ width: '100%' }} />
        </FormField>

        <SubmitButton>{pending ? 'Saving…' : submitLabel}</SubmitButton>
      </form>
    </FormProvider>
  );
}
