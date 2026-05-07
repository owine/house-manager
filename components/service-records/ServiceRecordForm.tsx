'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { ItemAutocomplete } from '@/components/service-records/ItemAutocomplete';
import { VendorAutocomplete } from '@/components/service-records/VendorAutocomplete';
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
import { Textarea } from '@/components/ui/textarea';
import { applyActionFieldErrors } from '@/lib/forms/helpers';
import type { ActionResult } from '@/lib/result';
import type { CreateServiceRecordInput } from '@/lib/service-records/schema';

// Tactical single-target form schema. Wider multi-target picker arrives in
// Task 14; the action accepts the multi-target shape from any caller.
const formSchema = z.object({
  itemId: z.string().min(1).optional(),
  vendorId: z.string().min(1).optional(),
  performedOn: z.coerce.date(),
  cost: z.coerce.number().nonnegative().optional(),
  summary: z.string().min(1, 'Summary is required').max(200),
  notes: z.string().max(20_000).optional(),
});

type ServiceRecordFormValues = z.input<typeof formSchema>;

type FormDefaults = {
  id?: string;
  itemId?: string;
  vendorId?: string;
  performedOn?: Date | string;
  cost?: number;
  summary?: string;
  notes?: string;
};

type Props = {
  items: { id: string; name: string }[];
  vendors: { id: string; name: string }[];
  defaultValues?: FormDefaults;
  action: (
    input: CreateServiceRecordInput | (CreateServiceRecordInput & { id: string }),
  ) => Promise<ActionResult<{ id: string }>>;
  submitLabel: string;
};

export function ServiceRecordForm({ items, vendors, defaultValues, action, submitLabel }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const performedOnDefault = defaultValues?.performedOn
    ? defaultValues.performedOn instanceof Date
      ? defaultValues.performedOn.toISOString().slice(0, 10)
      : String(defaultValues.performedOn)
    : ('' as unknown as Date);

  const form = useForm<ServiceRecordFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      itemId: defaultValues?.itemId ?? undefined,
      vendorId: defaultValues?.vendorId ?? undefined,
      cost: defaultValues?.cost ?? undefined,
      summary: defaultValues?.summary ?? '',
      notes: defaultValues?.notes ?? '',
      performedOn: performedOnDefault,
    },
  });

  const {
    control,
    handleSubmit,
    setError,
    formState: { errors },
  } = form;

  const formError = (errors as { root?: { message?: string } }).root?.message;

  const onSubmit = handleSubmit((formData) => {
    startTransition(async () => {
      const { itemId, ...rest } = formData as ServiceRecordFormValues;
      // Build canonical multi-target payload. The form currently only edits a
      // single item-target; users without an item are blocked here because the
      // action requires targets.min(1). For records with neither item nor
      // vendor, callers must use a Task 14 picker instead.
      if (!itemId) {
        setError('itemId', {
          message: 'Select an item (multi-target picker arrives in a later task)',
        });
        return;
      }
      const payload: CreateServiceRecordInput & { id?: string } = {
        ...(rest as Omit<ServiceRecordFormValues, 'itemId'> as CreateServiceRecordInput),
        targets: [{ itemId }],
        ...(defaultValues?.id ? { id: defaultValues.id } : {}),
      };
      const result = await action(payload as CreateServiceRecordInput & { id: string });
      if (!result.ok) {
        const applied = applyActionFieldErrors(setError, result);
        if (result.formError) setError('root', { message: result.formError });
        if (!applied && !result.formError) toast.error('Failed to save service record');
        return;
      }
      const isEdit = !!defaultValues?.id;
      toast.success(isEdit ? 'Service record updated' : 'Service record created');
      router.push(`/service/${result.data.id}`);
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

        {/* Item autocomplete */}
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

        {/* Vendor autocomplete */}
        <FormField
          control={control}
          name="vendorId"
          render={() => (
            <FormItem>
              <FormLabel>Vendor (optional)</FormLabel>
              <FormControl>
                <VendorAutocomplete name="vendorId" label="" options={vendors} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={control}
          name="performedOn"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Performed on</FormLabel>
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
          name="cost"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Cost (USD)</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
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
          name="summary"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Summary</FormLabel>
              <FormControl>
                <Input {...field} required />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={control}
          name="notes"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Notes (markdown)</FormLabel>
              <FormControl>
                <Textarea rows={6} {...field} value={field.value ?? ''} />
              </FormControl>
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
