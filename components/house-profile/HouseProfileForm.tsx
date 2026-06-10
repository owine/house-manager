'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormDescription,
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
import { applyActionFieldErrors } from '@/lib/forms/helpers';
import { saveHouseProfile } from '@/lib/house-profile/actions';
import { type HouseProfileInput, houseProfileSchema } from '@/lib/house-profile/schema';
import { TIMEZONE_OPTIONS } from '@/lib/time/timezones';

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
  const form = useForm<FormValues>({
    resolver: zodResolver(houseProfileSchema),
    defaultValues,
  });

  async function onSubmit(values: FormValues) {
    startTransition(async () => {
      const result = await saveHouseProfile(values);
      if (!result.ok) {
        const applied = applyActionFieldErrors(form.setError, result);
        if (result.formError) form.setError('root', { message: result.formError });
        if (!applied && !result.formError) toast.error('Failed to save');
        return;
      }
      toast.success('Settings saved');
    });
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        {form.formState.errors.root?.message && (
          <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            {form.formState.errors.root.message}
          </p>
        )}

        <FormField
          control={form.control}
          name="location"
          render={({ field }) => (
            <FormItem>
              <FormLabel>City or region</FormLabel>
              <FormControl>
                <Input {...field} value={field.value ?? ''} />
              </FormControl>
              <FormDescription>
                Used to tailor AI maintenance suggestions. Keep it general (e.g., &apos;Austin,
                TX&apos;); don&apos;t enter a street address.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="climateZone"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Climate zone</FormLabel>
              <FormControl>
                <Input list="iecc-zones" className="w-24" {...field} />
              </FormControl>
              <datalist id="iecc-zones">
                {IECC_ZONES.map((zone) => (
                  <option key={zone} value={zone} />
                ))}
              </datalist>
              <FormDescription>IECC zone (e.g. 3B) or any custom value</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="propertyType"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Property type</FormLabel>
              <Select onValueChange={field.onChange} value={field.value ?? ''}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="(none)" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {PROPERTY_TYPE_OPTIONS.map(({ value, label }) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="timezone"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Timezone</FormLabel>
              <Select onValueChange={field.onChange} value={field.value ?? 'UTC'}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {TIMEZONE_OPTIONS.map((tz) => (
                    <SelectItem key={tz} value={tz}>
                      {tz}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormDescription>
                Drives every due date, overdue check, reminder/digest email, and the calendar feed.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </form>
    </Form>
  );
}
