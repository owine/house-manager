'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
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

  const form = useForm<ServiceRecordFormValues>({
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
    control,
    handleSubmit,
    setError,
    formState: { errors },
  } = form;

  const formError = (errors as { root?: { message?: string } }).root?.message;

  const onSubmit = handleSubmit((data) => {
    startTransition(async () => {
      const payload = defaultValues?.id ? { ...data, id: defaultValues.id } : data;
      const result = await action(payload as unknown as CreateServiceRecordInput);
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
              <FormLabel>Item (optional)</FormLabel>
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
