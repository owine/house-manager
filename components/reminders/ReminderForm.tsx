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
import {
  type CreateReminderInput,
  createReminderSchema,
  type Recurrence,
} from '@/lib/reminders/schema';
import type { ActionResult } from '@/lib/result';
import { RecurrencePicker } from './RecurrencePicker';

type FormValues = z.input<typeof createReminderSchema>;

type Props = {
  items: { id: string; name: string }[];
  defaultValues?: Partial<CreateReminderInput & { id: string }>;
  action: (
    input: CreateReminderInput | (CreateReminderInput & { id: string }),
  ) => Promise<ActionResult<{ id: string }>>;
  submitLabel: string;
};

export function ReminderForm({ items, defaultValues, action, submitLabel }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const methods = useForm<FormValues>({
    resolver: zodResolver(createReminderSchema),
    defaultValues: {
      autoCreateServiceRecord: false,
      leadTimeDays: 3,
      recurrence: { kind: 'interval', days: 60 },
      ...defaultValues,
    },
  });
  const {
    register,
    handleSubmit,
    control,
    setError,
    formState: { errors },
  } = methods;
  const formError = (errors as { root?: { message?: string } }).root?.message;

  const onSubmit = handleSubmit((data) => {
    startTransition(async () => {
      const payload = defaultValues?.id ? { ...data, id: defaultValues.id } : data;
      const result = await action(payload as CreateReminderInput);
      if (!result.ok) {
        if (result.formError) setError('root', { message: result.formError });
        if (result.fieldErrors) {
          for (const [field, msgs] of Object.entries(result.fieldErrors)) {
            setError(field as keyof FormValues, { message: msgs?.[0] });
          }
        }
        return;
      }
      router.push(`/reminders/${result.data.id}`);
    });
  });

  return (
    <FormProvider {...methods}>
      <form
        onSubmit={onSubmit}
        style={{ maxWidth: 640, display: 'flex', flexDirection: 'column', gap: '0.75rem' }}
      >
        <ErrorBanner message={formError} />
        <FormField label="Title" htmlFor="title" error={errors.title?.message}>
          <input id="title" {...register('title')} required />
        </FormField>
        <FormField
          label="Description (markdown)"
          htmlFor="description"
          error={errors.description?.message}
        >
          <textarea id="description" rows={4} {...register('description')} />
        </FormField>
        <FormField label="Item" htmlFor="itemId" error={errors.itemId?.message}>
          <ItemAutocomplete name="itemId" label="" options={items} />
        </FormField>
        <Controller
          control={control}
          name="recurrence"
          render={({ field }) => (
            <RecurrencePicker
              defaultValue={field.value as Recurrence | undefined}
              onChange={(rec) => field.onChange(rec)}
            />
          )}
        />
        <FormField label="First due date" htmlFor="nextDueOn" error={errors.nextDueOn?.message}>
          <input id="nextDueOn" type="date" {...register('nextDueOn')} required />
        </FormField>
        <FormField
          label="Lead time (days)"
          htmlFor="leadTimeDays"
          error={errors.leadTimeDays?.message}
        >
          <input
            id="leadTimeDays"
            type="number"
            min={0}
            max={365}
            {...register('leadTimeDays', { valueAsNumber: true })}
          />
        </FormField>
        <FormField
          label="Auto-create service record on completion"
          htmlFor="autoCreateServiceRecord"
          error={errors.autoCreateServiceRecord?.message}
        >
          <input
            id="autoCreateServiceRecord"
            type="checkbox"
            {...register('autoCreateServiceRecord')}
          />
        </FormField>
        <SubmitButton>{pending ? 'Saving…' : submitLabel}</SubmitButton>
      </form>
    </FormProvider>
  );
}
