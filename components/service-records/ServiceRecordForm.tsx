'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { VendorAutocomplete } from '@/components/service-records/VendorAutocomplete';
import {
  type AvailableItem,
  type AvailableSystem,
  TargetsPicker,
} from '@/components/targets/TargetsPicker';
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
import type { TargetInput } from '@/lib/targets/schema';

const formSchema = z.object({
  vendorId: z.string().min(1).optional(),
  performedOn: z.coerce.date(),
  cost: z.coerce.number().nonnegative().optional(),
  summary: z.string().min(1, 'Summary is required').max(200),
  notes: z.string().max(20_000).optional(),
});

type ServiceRecordFormValues = z.input<typeof formSchema>;

type FormDefaults = {
  id?: string;
  vendorId?: string;
  performedOn?: Date | string;
  cost?: number;
  summary?: string;
  notes?: string;
};

type Props = {
  vendors: { id: string; name: string }[];
  availableItems: AvailableItem[];
  availableSystems: AvailableSystem[];
  /** Pre-seeded targets used both for "create from item/system page" and edit. */
  initialTargets?: TargetInput[];
  defaultValues?: FormDefaults;
  action: (
    input: CreateServiceRecordInput | (CreateServiceRecordInput & { id: string }),
  ) => Promise<ActionResult<{ id: string }>>;
  submitLabel: string;
};

export function ServiceRecordForm({
  vendors,
  availableItems,
  availableSystems,
  initialTargets,
  defaultValues,
  action,
  submitLabel,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [targets, setTargets] = useState<TargetInput[]>(initialTargets ?? []);
  const [targetsError, setTargetsError] = useState<string | null>(null);

  const performedOnDefault = defaultValues?.performedOn
    ? defaultValues.performedOn instanceof Date
      ? defaultValues.performedOn.toISOString().slice(0, 10)
      : String(defaultValues.performedOn)
    : ('' as unknown as Date);

  const form = useForm<ServiceRecordFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
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
    // The Zod schema enforces "vendor OR at least one target". Pre-flight
    // here mirrors that rule so the user gets feedback without the
    // round-trip when both are empty.
    const hasVendor = Boolean((formData as { vendorId?: string }).vendorId);
    if (!hasVendor && targets.length === 0) {
      setTargetsError('Pick a vendor or at least one item/system');
      return;
    }
    setTargetsError(null);
    startTransition(async () => {
      const payload: CreateServiceRecordInput & { id?: string } = {
        ...(formData as CreateServiceRecordInput),
        targets,
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

  const handleTargetsChange = (next: TargetInput[]) => {
    setTargets(next);
    if (next.length > 0 && targetsError) setTargetsError(null);
  };

  return (
    <Form {...form}>
      <form onSubmit={onSubmit} className="space-y-6">
        {formError && (
          <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            {formError}
          </p>
        )}

        <FormItem>
          <FormLabel>Targets</FormLabel>
          <TargetsPicker
            value={targets}
            onChange={handleTargetsChange}
            availableItems={availableItems}
            availableSystems={availableSystems}
          />
          {targetsError && (
            <p className="text-sm text-destructive" role="alert">
              {targetsError}
            </p>
          )}
        </FormItem>

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
                  className="w-40"
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
                  className="w-32"
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
                <Input {...field} required value={field.value ?? ''} />
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
                <Textarea rows={10} {...field} value={field.value ?? ''} />
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
