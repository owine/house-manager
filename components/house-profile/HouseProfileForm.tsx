'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTransition } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { ErrorBanner } from '@/components/forms/ErrorBanner';
import { FormField } from '@/components/forms/FormField';
import { saveHouseProfile } from '@/lib/house-profile/actions';
import { type HouseProfileInput, houseProfileSchema } from '@/lib/house-profile/schema';

// z.input preserves optional/literal-'' before the resolver transforms the value.
type FormValues = z.input<typeof houseProfileSchema>;

const PROPERTY_TYPE_OPTIONS: { value: HouseProfileInput['propertyType']; label: string }[] = [
  { value: 'single-family', label: 'Single-family' },
  { value: 'townhome', label: 'Townhome' },
  { value: 'condo', label: 'Condo' },
  { value: 'multi-family', label: 'Multi-family' },
  { value: 'other', label: 'Other' },
];

// Common IECC climate zones for datalist autocomplete; user may type any custom value.
const IECC_ZONES = [
  '1A',
  '2A',
  '2B',
  '3A',
  '3B',
  '3C',
  '4A',
  '4B',
  '4C',
  '5A',
  '5B',
  '5C',
  '6A',
  '6B',
  '7',
  '8',
];

type Props = {
  defaultValues: HouseProfileInput;
};

export function HouseProfileForm({ defaultValues }: Props) {
  const [pending, startTransition] = useTransition();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(houseProfileSchema),
    defaultValues,
  });

  const formError = (errors as { root?: { message?: string } }).root?.message;

  const onSubmit = handleSubmit((data) => {
    startTransition(async () => {
      const result = await saveHouseProfile(data);
      if (!result.ok) {
        if (result.formError) setError('root', { message: result.formError });
        if (result.fieldErrors) {
          for (const [field, msgs] of Object.entries(result.fieldErrors)) {
            setError(field as keyof FormValues, { message: msgs?.[0] });
          }
        }
      }
      // On success the page re-renders via revalidatePath, showing the saved
      // values — no explicit redirect or "Saved" state needed.
    });
  });

  return (
    <form onSubmit={onSubmit} style={{ maxWidth: 600 }}>
      <ErrorBanner message={formError} />

      <FormField label="Location" htmlFor="location" error={errors.location?.message}>
        <input id="location" {...register('location')} style={{ width: '100%' }} />
      </FormField>

      <FormField
        label="Climate zone"
        htmlFor="climateZone"
        error={errors.climateZone?.message}
        hint="IECC zone (e.g. 3B) or any custom value"
      >
        <input
          id="climateZone"
          list="iecc-zones"
          {...register('climateZone')}
          style={{ width: '100%' }}
        />
        <datalist id="iecc-zones">
          {IECC_ZONES.map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
      </FormField>

      <FormField label="Property type" htmlFor="propertyType" error={errors.propertyType?.message}>
        <select id="propertyType" {...register('propertyType')} style={{ width: '100%' }}>
          <option value="">(none)</option>
          {PROPERTY_TYPE_OPTIONS.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </FormField>

      <button
        type="submit"
        disabled={pending}
        style={{ padding: '0.5rem 1rem', marginTop: '0.5rem' }}
      >
        {pending ? 'Saving…' : 'Save'}
      </button>
    </form>
  );
}
