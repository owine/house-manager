'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import type { PartKind } from '@prisma/client';
import { Plus, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useTransition } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { PartKindFields } from '@/components/parts/PartKindFields';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { applyActionFieldErrors } from '@/lib/forms/helpers';
import { PART_KIND_LABELS } from '@/lib/parts/kind-labels';
import { type CreatePartInput, createPartSchema, PART_KINDS } from '@/lib/parts/schema';
import type { ActionResult } from '@/lib/result';

// z.input, not z.infer: `kind`/`purchaseLinks`/`metadata` carry `.default()`
// and `typicalCost`/`packQuantity` are `z.coerce`, so the pre-parse shape is
// what form state actually holds.
type PartFormValues = z.input<typeof createPartSchema>;

type Props = {
  defaultValues?: Partial<CreatePartInput & { id: string }>;
  action: (
    input: CreatePartInput | (CreatePartInput & { id: string }),
  ) => Promise<ActionResult<{ id: string }>>;
  submitLabel: string;
};

/** Render a nullable numeric field value as an input-safe string. */
function numberInputValue(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

export function PartForm({ defaultValues, action, submitLabel }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const form = useForm<PartFormValues>({
    resolver: zodResolver(createPartSchema),
    defaultValues: {
      name: '',
      kind: 'OTHER',
      purchaseLinks: [],
      metadata: {},
      ...defaultValues,
    },
  });

  const {
    handleSubmit,
    setError,
    watch,
    setValue,
    control,
    formState: { errors },
  } = form;

  const formError = (errors as { root?: { message?: string } }).root?.message;
  const watchedKind = (watch('kind') ?? 'OTHER') as PartKind;

  const purchaseLinks = useFieldArray({ control, name: 'purchaseLinks' });

  // Reset the spec blob when the kind *changes*, so a bulb's watts don't leak
  // into an air filter.
  //
  // The ref guard is load-bearing, and its absence is a shipped bug on the item
  // side (fixed in 5efebda): a useEffect keyed on a watched value also fires on
  // MOUNT, and `watchedKind` is populated from `defaultValues` on the first
  // render — so a naive `!== undefined` guard passes immediately and wipes the
  // stored spec of every part opened in the edit form. An untouched save then
  // submits `metadata: {}`.
  //
  // It hides on screen because the shadcn Select keeps its own uncontrolled
  // value, so the form still *looks* populated while the payload is empty.
  // The regression test in PartForm.test.tsx therefore asserts on the SUBMITTED
  // PAYLOAD, not on rendered inputs.
  const prevKind = useRef(watchedKind);
  useEffect(() => {
    if (prevKind.current === watchedKind) return;
    prevKind.current = watchedKind;
    setValue('metadata', {});
  }, [watchedKind, setValue]);

  const onSubmit = handleSubmit((data) => {
    startTransition(async () => {
      const payload = defaultValues?.id ? { ...data, id: defaultValues.id } : data;
      const result = await action(payload as unknown as CreatePartInput);
      if (!result.ok) {
        const applied = applyActionFieldErrors(setError, result);
        if (result.formError) setError('root', { message: result.formError });
        if (!applied && !result.formError) toast.error('Failed to save part');
        return;
      }
      toast.success(defaultValues?.id ? 'Part updated' : 'Part created');
      router.push(`/parts/${result.data.id}`);
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
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input {...field} value={field.value ?? ''} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={control}
          name="kind"
          render={({ field }) => {
            const kindItems = PART_KINDS.map((k) => ({ label: PART_KIND_LABELS[k], value: k }));
            return (
              <FormItem>
                <FormLabel>Kind</FormLabel>
                <Select
                  items={kindItems}
                  onValueChange={field.onChange}
                  value={field.value ?? 'OTHER'}
                >
                  <FormControl>
                    <SelectTrigger className="w-full" data-testid="part-form-kind-trigger">
                      <SelectValue placeholder="— select kind —" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {kindItems.map((it) => (
                      <SelectItem key={it.value} value={it.value}>
                        {it.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            );
          }}
        />

        <FormField
          control={control}
          name="location"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Location</FormLabel>
              <FormControl>
                <Input {...field} value={field.value ?? ''} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={control}
          name="manufacturer"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Manufacturer</FormLabel>
              <FormControl>
                <Input {...field} value={field.value ?? ''} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={control}
          name="model"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Model</FormLabel>
              <FormControl>
                <Input {...field} value={field.value ?? ''} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={control}
          name="sku"
          render={({ field }) => (
            <FormItem>
              <FormLabel>SKU</FormLabel>
              <FormControl>
                <Input {...field} value={field.value ?? ''} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={control}
          name="typicalCost"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Typical cost</FormLabel>
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
                  value={numberInputValue(field.value)}
                  onChange={(e) =>
                    field.onChange(e.target.value === '' ? undefined : Number(e.target.value))
                  }
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={control}
          name="packQuantity"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Pack quantity</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  className="w-32"
                  step="1"
                  min="1"
                  name={field.name}
                  ref={field.ref}
                  onBlur={field.onBlur}
                  disabled={field.disabled}
                  value={numberInputValue(field.value)}
                  onChange={(e) =>
                    field.onChange(e.target.value === '' ? undefined : Number(e.target.value))
                  }
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">Purchase links</legend>
          {purchaseLinks.fields.map((entry, index) => (
            <div key={entry.id} className="flex flex-wrap items-end gap-2">
              <FormField
                control={control}
                name={`purchaseLinks.${index}.label`}
                render={({ field }) => (
                  <FormItem className="w-40">
                    <FormLabel>Label</FormLabel>
                    <FormControl>
                      <Input {...field} value={field.value ?? ''} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={control}
                name={`purchaseLinks.${index}.url`}
                render={({ field }) => (
                  <FormItem className="min-w-56 flex-1">
                    <FormLabel>URL</FormLabel>
                    <FormControl>
                      <Input {...field} value={field.value ?? ''} placeholder="https://" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove purchase link ${index + 1}`}
                onClick={() => purchaseLinks.remove(index)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
          {purchaseLinks.fields.length < 10 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => purchaseLinks.append({ label: '', url: '' })}
            >
              <Plus className="h-4 w-4" />
              Add purchase link
            </Button>
          )}
        </fieldset>

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

        <PartKindFields kind={watchedKind} />

        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : submitLabel}
        </Button>
      </form>
    </Form>
  );
}
