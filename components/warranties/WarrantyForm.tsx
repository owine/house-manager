'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
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
import type { TargetInput } from '@/lib/targets/schema';
import type { CreateWarrantyInput } from '@/lib/warranties/schema';

const formSchema = z
  .object({
    provider: z.string().min(1, 'Provider is required').max(200),
    policyNumber: z.string().max(200).optional(),
    startsOn: z.coerce.date(),
    endsOn: z.coerce.date(),
    coverage: z.string().max(20_000).optional(),
    cost: z.coerce.number().nonnegative().optional(),
  })
  .refine((data) => data.endsOn >= data.startsOn, {
    message: 'End date must be on or after start date',
    path: ['endsOn'],
  });

type WarrantyFormValues = z.input<typeof formSchema>;

type FormDefaults = {
  id?: string;
  provider?: string;
  policyNumber?: string;
  startsOn?: Date | string;
  endsOn?: Date | string;
  coverage?: string;
  cost?: number;
};

type Props = {
  availableItems: AvailableItem[];
  availableSystems: AvailableSystem[];
  /**
   * Pre-seeded targets used both for "create from item/system page" and
   * editing an existing warranty. Defaults to empty.
   */
  initialTargets?: TargetInput[];
  /** Optional explicit redirect after a successful submit. */
  successRedirect?: string;
  defaultValues?: FormDefaults;
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

export function WarrantyForm({
  availableItems,
  availableSystems,
  initialTargets,
  successRedirect,
  defaultValues,
  action,
  submitLabel,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [targets, setTargets] = useState<TargetInput[]>(initialTargets ?? []);
  const [targetsError, setTargetsError] = useState<string | null>(null);

  const form = useForm<WarrantyFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      provider: defaultValues?.provider ?? '',
      policyNumber: defaultValues?.policyNumber ?? '',
      startsOn: dateToInputString(defaultValues?.startsOn) as unknown as Date,
      endsOn: dateToInputString(defaultValues?.endsOn) as unknown as Date,
      coverage: defaultValues?.coverage ?? '',
      cost: defaultValues?.cost ?? undefined,
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
    if (targets.length === 0) {
      setTargetsError('Select at least one item or system');
      return;
    }
    setTargetsError(null);
    startTransition(async () => {
      const payload: CreateWarrantyInput & { id?: string } = {
        ...(formData as CreateWarrantyInput),
        targets,
        ...(defaultValues?.id ? { id: defaultValues.id } : {}),
      };
      const result = await action(payload as CreateWarrantyInput & { id: string });
      if (!result.ok) {
        const applied = applyActionFieldErrors(setError, result);
        if (result.formError) setError('root', { message: result.formError });
        if (!applied && !result.formError) toast.error('Failed to save warranty');
        return;
      }
      const isEdit = !!defaultValues?.id;
      toast.success(isEdit ? 'Warranty updated' : 'Warranty created');
      // Default redirect: stay on the first item-target's page if there is one,
      // otherwise the warranty detail.
      const fallback = (() => {
        const firstItem = targets.find((t) => t.itemId)?.itemId;
        if (firstItem) return `/items/${firstItem}?tab=warranties`;
        return `/warranties/${result.data.id}`;
      })();
      router.push(successRedirect ?? fallback);
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
          name="provider"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Provider</FormLabel>
              <FormControl>
                <Input {...field} required value={field.value ?? ''} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={control}
          name="policyNumber"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Policy number</FormLabel>
              <FormControl>
                <Input {...field} value={field.value ?? ''} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={control}
          name="startsOn"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Starts on</FormLabel>
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
          name="endsOn"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Ends on</FormLabel>
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
          name="coverage"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Coverage</FormLabel>
              <FormControl>
                <Textarea rows={4} {...field} value={field.value ?? ''} />
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

        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : submitLabel}
        </Button>
      </form>
    </Form>
  );
}
