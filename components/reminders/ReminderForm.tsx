'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { ItemAutocomplete } from '@/components/service-records/ItemAutocomplete';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { applyActionFieldErrors } from '@/lib/forms/helpers';
import {
  type CreateReminderInput,
  type Recurrence,
  recurrenceSchema,
} from '@/lib/reminders/schema';
import type { ActionResult } from '@/lib/result';
import { RecurrencePicker } from './RecurrencePicker';

// Single-target form shim: the form models a single `itemId` field; the
// action receives a `targets` array. Task 14/15 will replace this with a
// proper TargetsPicker.
const reminderFormSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(20_000).optional().or(z.literal('')),
  itemId: z.string().min(1).optional(),
  recurrence: recurrenceSchema,
  nextDueOn: z.coerce.date(),
  leadTimeDays: z.number().int().min(0).max(365).default(3),
  autoCreateServiceRecord: z.boolean().default(false),
});

type FormValues = z.input<typeof reminderFormSchema>;
type ParsedFormValues = z.output<typeof reminderFormSchema>;

type Props = {
  items: { id: string; name: string }[];
  defaultValues?: Partial<ParsedFormValues & { id: string }>;
  action: (
    input: CreateReminderInput | (CreateReminderInput & { id: string }),
  ) => Promise<ActionResult<{ id: string }>>;
  submitLabel: string;
};

export function ReminderForm({ items, defaultValues, action, submitLabel }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const form = useForm<FormValues>({
    resolver: zodResolver(reminderFormSchema),
    defaultValues: {
      autoCreateServiceRecord: false,
      leadTimeDays: 3,
      recurrence: { kind: 'interval', days: 60 },
      ...defaultValues,
    },
  });

  const {
    handleSubmit,
    control,
    setError,
    formState: { errors },
  } = form;

  const formError = (errors as { root?: { message?: string } }).root?.message;

  const onSubmit = handleSubmit((data) => {
    startTransition(async () => {
      const { itemId, ...rest } = data as ParsedFormValues;
      const targets = itemId ? [{ itemId }] : [];
      const base = { ...rest, targets } as CreateReminderInput;
      const payload = defaultValues?.id ? { ...base, id: defaultValues.id } : base;
      const result = await action(payload);
      if (!result.ok) {
        const applied = applyActionFieldErrors(setError, result);
        if (result.formError) setError('root', { message: result.formError });
        if (!applied && !result.formError) toast.error('Failed to save reminder');
        return;
      }
      const isEdit = !!defaultValues?.id;
      toast.success(isEdit ? 'Reminder updated' : 'Reminder created');
      router.push(`/reminders/${result.data.id}`);
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

        <FormField
          control={control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Description (markdown)</FormLabel>
              <FormControl>
                <Textarea rows={4} {...field} value={field.value ?? ''} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={control}
          name="itemId"
          render={() => (
            <FormItem>
              <FormLabel>Item</FormLabel>
              <FormControl>
                <ItemAutocomplete name="itemId" label="" options={items} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

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

        <FormField
          control={control}
          name="nextDueOn"
          render={({ field }) => (
            <FormItem>
              <FormLabel>First due date</FormLabel>
              <FormControl>
                <Input
                  type="date"
                  name={field.name}
                  ref={field.ref}
                  onBlur={field.onBlur}
                  disabled={field.disabled}
                  value={
                    field.value instanceof Date
                      ? field.value.toISOString().slice(0, 10)
                      : typeof field.value === 'string'
                        ? field.value
                        : ''
                  }
                  onChange={(e) => {
                    const v = e.target.value;
                    field.onChange(v === '' ? undefined : v);
                  }}
                  required
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={control}
          name="leadTimeDays"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Lead time (days)</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  min={0}
                  max={365}
                  name={field.name}
                  ref={field.ref}
                  onBlur={field.onBlur}
                  disabled={field.disabled}
                  value={typeof field.value === 'number' ? field.value : ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    field.onChange(v === '' ? undefined : Number(v));
                  }}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={control}
          name="autoCreateServiceRecord"
          render={({ field }) => (
            <FormItem className="flex items-center gap-2">
              <FormControl>
                <Checkbox
                  id="autoCreateServiceRecord"
                  checked={!!field.value}
                  onCheckedChange={field.onChange}
                  ref={field.ref}
                  name={field.name}
                  disabled={field.disabled}
                />
              </FormControl>
              <FormLabel htmlFor="autoCreateServiceRecord" className="!mt-0 cursor-pointer">
                Auto-create service record on completion
              </FormLabel>
              <FormMessage />
            </FormItem>
          )}
        />

        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : submitLabel}
        </Button>
      </form>
    </Form>
  );
}
