'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { useForm } from 'react-hook-form';
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
import { createSystemSchema, type SystemCreateInput } from '@/lib/systems/schema';

type FormValues = z.input<typeof createSystemSchema>;

export type SystemFormDefaults = Partial<SystemCreateInput & { id: string }>;

type Props = {
  defaultValues?: SystemFormDefaults;
  action: (
    input: SystemCreateInput | (SystemCreateInput & { id: string }),
  ) => Promise<ActionResult<{ id: string }>>;
  submitLabel: string;
  /** Optional override for the post-success redirect target. Defaults to `/systems/<id>`. */
  redirectTo?: (id: string) => string;
};

export function SystemForm({ defaultValues, action, submitLabel, redirectTo }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const isEdit = Boolean(defaultValues?.id);

  const form = useForm<FormValues>({
    resolver: zodResolver(createSystemSchema),
    defaultValues: {
      name: '',
      kind: '',
      location: '',
      installDate: undefined,
      installCost: undefined,
      notes: '',
      ...defaultValues,
    },
  });

  const {
    handleSubmit,
    setError,
    formState: { errors },
  } = form;
  const formError = (errors as { root?: { message?: string } }).root?.message;

  const onSubmit = handleSubmit((data) => {
    startTransition(async () => {
      const payload = isEdit && defaultValues?.id ? { ...data, id: defaultValues.id } : data;
      const result = await action(payload as unknown as SystemCreateInput);
      if (!result.ok) {
        const applied = applyActionFieldErrors(setError, result);
        if (result.formError) setError('root', { message: result.formError });
        if (!applied && !result.formError) toast.error('Failed to save system');
        return;
      }
      toast.success(isEdit ? 'System updated' : 'System created');
      const target = redirectTo ? redirectTo(result.data.id) : `/systems/${result.data.id}`;
      router.push(target);
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
                <Input {...field} value={field.value ?? ''} />
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
                <Input
                  {...field}
                  value={field.value ?? ''}
                  placeholder="e.g. hvac, plumbing, electrical"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
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
          control={form.control}
          name="installDate"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Install date</FormLabel>
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
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="installCost"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Install cost</FormLabel>
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

        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : submitLabel}
        </Button>
      </form>
    </Form>
  );
}

export default SystemForm;
