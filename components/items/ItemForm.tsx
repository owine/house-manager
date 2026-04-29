'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import type { Category } from '@prisma/client';
import { useRouter } from 'next/navigation';
import { useEffect, useTransition } from 'react';
import { FormProvider, useForm } from 'react-hook-form';
import type { z } from 'zod';
import { ErrorBanner } from '@/components/forms/ErrorBanner';
import { FormField } from '@/components/forms/FormField';
import { SubmitButton } from '@/components/forms/SubmitButton';
import { ItemMetadataFields } from '@/components/items/ItemMetadataFields';
import { type CreateItemInput, createItemSchema } from '@/lib/items/schema';
import type { ActionResult } from '@/lib/result';

// Use z.input so purchaseDate stays as string in form state (resolver coerces via z.coerce.date)
type ItemFormValues = z.input<typeof createItemSchema>;

type Props = {
  categories: Category[];
  defaultValues?: Partial<CreateItemInput & { id: string }>;
  action: (
    input: CreateItemInput | (CreateItemInput & { id: string }),
  ) => Promise<ActionResult<{ id: string }>>;
  submitLabel: string;
};

export function ItemForm({ categories, defaultValues, action, submitLabel }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const methods = useForm<ItemFormValues>({
    resolver: zodResolver(createItemSchema),
    defaultValues: {
      name: '',
      categorySlug: '',
      metadata: {},
      ...defaultValues,
    },
  });

  const {
    register,
    handleSubmit,
    setError,
    watch,
    setValue,
    formState: { errors },
  } = methods;

  const formError = (errors as { root?: { message?: string } }).root?.message;
  const watchedCategorySlug = watch('categorySlug');

  // Reset metadata when category changes so previous-category values don't leak.
  // watchedCategorySlug is intentionally omitted from deps: we only want this
  // effect to fire because the slug changed (the value itself is read via the
  // closure captured by the effect, not as a stable dep).
  // biome-ignore lint/correctness/useExhaustiveDependencies: metadata reset must run on slug change
  useEffect(() => {
    setValue('metadata', {});
  }, [watchedCategorySlug, setValue]);

  const onSubmit = handleSubmit((data) => {
    startTransition(async () => {
      const payload = defaultValues?.id ? { ...data, id: defaultValues.id } : data;
      const result = await action(payload as unknown as CreateItemInput);
      if (!result.ok) {
        if (result.formError) setError('root', { message: result.formError });
        if (result.fieldErrors) {
          for (const [field, msgs] of Object.entries(result.fieldErrors)) {
            setError(field as keyof ItemFormValues, { message: msgs?.[0] });
          }
        }
        return;
      }
      router.push(`/items/${result.data.id}`);
    });
  });

  return (
    <FormProvider {...methods}>
      <form onSubmit={onSubmit} style={{ maxWidth: 600 }}>
        <ErrorBanner message={formError} />

        <FormField label="Name" htmlFor="name" error={errors.name?.message}>
          <input id="name" {...register('name')} required />
        </FormField>

        <FormField label="Category" htmlFor="categorySlug" error={errors.categorySlug?.message}>
          <select id="categorySlug" {...register('categorySlug')} required>
            <option value="">— select category —</option>
            {categories.map((cat) => (
              <option key={cat.id} value={cat.slug}>
                {cat.name}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="Location" htmlFor="location" error={errors.location?.message}>
          <input id="location" {...register('location')} />
        </FormField>

        <FormField label="Manufacturer" htmlFor="manufacturer" error={errors.manufacturer?.message}>
          <input id="manufacturer" {...register('manufacturer')} />
        </FormField>

        <FormField label="Model" htmlFor="model" error={errors.model?.message}>
          <input id="model" {...register('model')} />
        </FormField>

        <FormField
          label="Serial number"
          htmlFor="serialNumber"
          error={errors.serialNumber?.message}
        >
          <input id="serialNumber" {...register('serialNumber')} />
        </FormField>

        <FormField
          label="Purchase date"
          htmlFor="purchaseDate"
          error={errors.purchaseDate?.message}
        >
          <input id="purchaseDate" type="date" {...register('purchaseDate')} />
        </FormField>

        <FormField
          label="Purchase price"
          htmlFor="purchasePrice"
          error={errors.purchasePrice?.message}
        >
          <input
            id="purchasePrice"
            type="number"
            step="0.01"
            min="0"
            {...register('purchasePrice', { valueAsNumber: true })}
          />
        </FormField>

        <FormField label="Notes (markdown)" htmlFor="notes" error={errors.notes?.message}>
          <textarea id="notes" rows={6} {...register('notes')} />
        </FormField>

        {watchedCategorySlug && <ItemMetadataFields slug={watchedCategorySlug} />}

        <SubmitButton>{pending ? 'Saving…' : submitLabel}</SubmitButton>
      </form>
    </FormProvider>
  );
}
