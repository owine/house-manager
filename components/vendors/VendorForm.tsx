'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
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
import { type CreateVendorInput, createVendorSchema } from '@/lib/vendors/schema';

// Use the Zod input type so `tags` (which has .default([])) is string[] | undefined,
// matching what react-hook-form sends before the resolver transforms it.
type VendorFormValues = z.input<typeof createVendorSchema>;

type Props = {
  defaultValues?: Partial<CreateVendorInput & { id: string }>;
  action: (
    input: CreateVendorInput | (CreateVendorInput & { id: string }),
  ) => Promise<ActionResult<{ id: string }>>;
  submitLabel: string;
};

export function VendorForm({ defaultValues, action, submitLabel }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const form = useForm<VendorFormValues>({
    resolver: zodResolver(createVendorSchema),
    defaultValues: { tags: [], ...defaultValues },
  });

  const {
    handleSubmit,
    setError,
    formState: { errors },
  } = form;

  const formError = (errors as { root?: { message?: string } }).root?.message;

  const onSubmit = handleSubmit((data) => {
    startTransition(async () => {
      const payload = defaultValues?.id ? { ...data, id: defaultValues.id } : data;
      const result = await action(payload as unknown as CreateVendorInput);
      if (!result.ok) {
        const applied = applyActionFieldErrors(setError, result);
        if (result.formError) setError('root', { message: result.formError });
        if (!applied && !result.formError) toast.error('Failed to save vendor');
        return;
      }
      const isEdit = !!defaultValues?.id;
      toast.success(isEdit ? 'Vendor updated' : 'Vendor created');
      router.push(`/vendors/${result.data.id}`);
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
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="kind"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Kind</FormLabel>
              <FormControl>
                <Input placeholder="e.g. plumber, hvac tech" {...field} value={field.value ?? ''} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="phone"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Phone</FormLabel>
              <FormControl>
                <Input {...field} value={field.value ?? ''} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input type="email" {...field} value={field.value ?? ''} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="website"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Website</FormLabel>
              <FormControl>
                <Input type="url" {...field} value={field.value ?? ''} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="address"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Address</FormLabel>
              <FormControl>
                <Textarea rows={2} {...field} value={field.value ?? ''} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
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

        {/* Tags: comma-separated input — same UX as before, just shadcn primitives */}
        <FormItem>
          <FormLabel>Tags (comma-separated)</FormLabel>
          <FormControl>
            <Controller
              control={form.control}
              name="tags"
              render={({ field }) => (
                <Input
                  id="tags"
                  defaultValue={(field.value ?? []).join(', ')}
                  onChange={(e) =>
                    field.onChange(
                      e.target.value
                        .split(',')
                        .map((t) => t.trim())
                        .filter(Boolean),
                    )
                  }
                />
              )}
            />
          </FormControl>
          {errors.tags && <FormMessage>{errors.tags.message as string}</FormMessage>}
        </FormItem>

        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : submitLabel}
        </Button>
      </form>
    </Form>
  );
}
