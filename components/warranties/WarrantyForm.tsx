'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { ErrorBanner } from '@/components/forms/ErrorBanner';
import { FormField } from '@/components/forms/FormField';
import { SubmitButton } from '@/components/forms/SubmitButton';
import type { ActionResult } from '@/lib/result';
import { type CreateWarrantyInput, createWarrantySchema } from '@/lib/warranties/schema';

// Use z.input so date fields stay as strings in form state (resolver coerces via z.coerce.date)
type WarrantyFormValues = z.input<typeof createWarrantySchema>;

type Props = {
  itemId: string;
  defaultValues?: Partial<CreateWarrantyInput & { id: string }>;
  action: (
    input: CreateWarrantyInput | (CreateWarrantyInput & { id: string }),
  ) => Promise<ActionResult<{ id: string }>>;
  submitLabel: string;
};

function dateToInputString(v: unknown): string {
  if (!v) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

export function WarrantyForm({ itemId, defaultValues, action, submitLabel }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<WarrantyFormValues>({
    resolver: zodResolver(createWarrantySchema),
    defaultValues: {
      itemId,
      provider: '',
      policyNumber: '',
      startsOn: dateToInputString(defaultValues?.startsOn) as unknown as Date,
      endsOn: dateToInputString(defaultValues?.endsOn) as unknown as Date,
      coverage: '',
      cost: undefined,
      ...defaultValues,
    },
  });

  const formError = (errors as { root?: { message?: string } }).root?.message;

  const onSubmit = handleSubmit((data) => {
    startTransition(async () => {
      const payload = defaultValues?.id ? { ...data, id: defaultValues.id } : data;
      const result = await action(payload as unknown as CreateWarrantyInput);
      if (!result.ok) {
        if (result.formError) setError('root', { message: result.formError });
        if (result.fieldErrors) {
          for (const [field, msgs] of Object.entries(result.fieldErrors)) {
            setError(field as Parameters<typeof setError>[0], { message: msgs?.[0] });
          }
        }
        return;
      }
      router.push(`/items/${itemId}?tab=warranties`);
    });
  });

  return (
    <form onSubmit={onSubmit} style={{ maxWidth: 600 }}>
      <ErrorBanner message={formError} />

      <input type="hidden" {...register('itemId')} value={itemId} />

      <FormField label="Provider" htmlFor="provider" error={errors.provider?.message}>
        <input id="provider" {...register('provider')} required style={{ width: '100%' }} />
      </FormField>

      <FormField label="Policy number" htmlFor="policyNumber" error={errors.policyNumber?.message}>
        <input id="policyNumber" {...register('policyNumber')} style={{ width: '100%' }} />
      </FormField>

      <FormField label="Starts on" htmlFor="startsOn" error={errors.startsOn?.message}>
        <input id="startsOn" type="date" {...register('startsOn')} required />
      </FormField>

      <FormField label="Ends on" htmlFor="endsOn" error={errors.endsOn?.message}>
        <input id="endsOn" type="date" {...register('endsOn')} required />
      </FormField>

      <FormField label="Coverage" htmlFor="coverage" error={errors.coverage?.message}>
        <textarea id="coverage" rows={4} {...register('coverage')} style={{ width: '100%' }} />
      </FormField>

      <FormField label="Cost (USD)" htmlFor="cost" error={errors.cost?.message}>
        <input
          id="cost"
          type="number"
          step="0.01"
          min="0"
          {...register('cost', {
            setValueAs: (v) => (v === '' || v === null || v === undefined ? undefined : Number(v)),
          })}
        />
      </FormField>

      <SubmitButton>{pending ? 'Saving…' : submitLabel}</SubmitButton>
    </form>
  );
}
