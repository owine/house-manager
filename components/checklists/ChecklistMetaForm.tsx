'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
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
import { createChecklistSchema } from '@/lib/checklists/schema';
import { applyActionFieldErrors } from '@/lib/forms/helpers';
import type { ActionResult } from '@/lib/result';

type FormValues = { name: string; description?: string };

type Props = {
  defaultValues?: { id?: string; name?: string; description?: string | null };
  action: (
    input: FormValues | (FormValues & { id: string }),
  ) => Promise<ActionResult<{ id: string }>>;
  submitLabel: string;
};

export function ChecklistMetaForm({ defaultValues, action, submitLabel }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const form = useForm<FormValues>({
    resolver: zodResolver(createChecklistSchema),
    defaultValues: {
      name: defaultValues?.name ?? '',
      description: defaultValues?.description ?? '',
    },
  });

  const {
    handleSubmit,
    setError,
    formState: { errors },
  } = form;
  const formError = (errors as { root?: { message?: string } }).root?.message;
  const isEdit = !!defaultValues?.id;

  const onSubmit = handleSubmit((data) => {
    startTransition(async () => {
      const payload = isEdit ? { ...data, id: defaultValues?.id ?? '' } : data;
      const result = await action(payload as FormValues & { id: string });
      if (!result.ok) {
        const applied = applyActionFieldErrors(setError, result);
        if (result.formError) setError('root', { message: result.formError });
        if (!applied && !result.formError) toast.error('Failed to save checklist');
        return;
      }
      toast.success(isEdit ? 'Checklist updated' : 'Checklist created');
      if (!isEdit) router.push(`/checklists/${result.data.id}`);
      else router.refresh();
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
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Description</FormLabel>
              <FormControl>
                <Textarea {...field} value={field.value ?? ''} rows={3} />
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
