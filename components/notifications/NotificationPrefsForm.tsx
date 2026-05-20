'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { LocalDate } from '@/components/ui/LocalDate';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { applyActionFieldErrors } from '@/lib/forms/helpers';
import { saveNotificationPrefs, unsubscribePush } from '@/lib/notifications/actions';
import type { NotificationPrefs } from '@/lib/notifications/prefs';
import { notificationPrefsSchema } from '@/lib/notifications/prefs';

type FormValues = z.input<typeof notificationPrefsSchema>;

const TIMEZONE_OPTIONS = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'Europe/London',
  'Europe/Paris',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Australia/Sydney',
];

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => ({
  value: String(h),
  label: `${String(h).padStart(2, '0')}:00`,
}));

type Props = {
  prefs: NotificationPrefs;
  subscriptions: { id: string; userAgent: string | null; createdAt: Date }[];
};

export function NotificationPrefsForm({ prefs, subscriptions }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [unsubscribePending, setUnsubscribePending] = useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(notificationPrefsSchema),
    defaultValues: prefs,
  });

  async function onSubmit(values: FormValues) {
    startTransition(async () => {
      const result = await saveNotificationPrefs(values);
      if (!result.ok) {
        const applied = applyActionFieldErrors(form.setError, result);
        if (result.formError) form.setError('root', { message: result.formError });
        if (!applied && !result.formError) toast.error('Failed to save');
        return;
      }
      toast.success('Saved');
    });
  }

  const handleUnsubscribe = async (id: string) => {
    setUnsubscribePending(true);
    try {
      await unsubscribePush(id);
      router.refresh();
    } catch (e) {
      console.error('Failed to unsubscribe', e);
    } finally {
      setUnsubscribePending(false);
    }
  };

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
          name="pushEnabled"
          render={({ field }) => (
            <FormItem className="flex flex-row items-center gap-2 space-y-0">
              <FormControl>
                <Checkbox checked={field.value} onCheckedChange={field.onChange} />
              </FormControl>
              <FormLabel className="cursor-pointer">Enable push notifications</FormLabel>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="emailEnabled"
          render={({ field }) => (
            <FormItem className="flex flex-row items-center gap-2 space-y-0">
              <FormControl>
                <Checkbox checked={field.value} onCheckedChange={field.onChange} />
              </FormControl>
              <FormLabel className="cursor-pointer">Enable email notifications</FormLabel>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="quietStart"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Quiet hours start</FormLabel>
              <FormControl>
                <Input
                  type="time"
                  className="w-32"
                  value={field.value ?? ''}
                  onChange={(e) => field.onChange(e.target.value || null)}
                  onBlur={field.onBlur}
                  name={field.name}
                  ref={field.ref}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="quietEnd"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Quiet hours end</FormLabel>
              <FormControl>
                <Input
                  type="time"
                  className="w-32"
                  value={field.value ?? ''}
                  onChange={(e) => field.onChange(e.target.value || null)}
                  onBlur={field.onBlur}
                  name={field.name}
                  ref={field.ref}
                />
              </FormControl>
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
              <Select onValueChange={field.onChange} value={field.value}>
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
              <FormMessage />
            </FormItem>
          )}
        />

        {/* --- Digest emails --- */}
        <div className="space-y-4">
          <h3 className="text-sm font-medium">Digest emails</h3>

          <FormField
            control={form.control}
            name="overdueDigestEnabled"
            render={({ field }) => (
              <FormItem className="flex flex-row items-center gap-2 space-y-0">
                <FormControl>
                  <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                </FormControl>
                <FormLabel className="cursor-pointer">Send an overdue digest daily</FormLabel>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="overdueDigestHour"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Overdue digest time</FormLabel>
                <Select
                  disabled={!form.watch('overdueDigestEnabled')}
                  value={String(field.value)}
                  onValueChange={(v) => field.onChange(Number(v))}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {HOUR_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
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
            name="weeklySummaryEnabled"
            render={({ field }) => (
              <FormItem className="flex flex-row items-center gap-2 space-y-0">
                <FormControl>
                  <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                </FormControl>
                <FormLabel className="cursor-pointer">Send a weekly summary</FormLabel>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="weeklySummaryDay"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Day</FormLabel>
                  <Select
                    disabled={!form.watch('weeklySummaryEnabled')}
                    value={String(field.value)}
                    onValueChange={(v) => field.onChange(Number(v))}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {[
                        'Sunday',
                        'Monday',
                        'Tuesday',
                        'Wednesday',
                        'Thursday',
                        'Friday',
                        'Saturday',
                      ].map((label, idx) => (
                        <SelectItem key={label} value={String(idx)}>
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
              name="weeklySummaryHour"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Time</FormLabel>
                  <Select
                    disabled={!form.watch('weeklySummaryEnabled')}
                    value={String(field.value)}
                    onValueChange={(v) => field.onChange(Number(v))}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {HOUR_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>

        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </Button>

        {subscriptions.length > 0 && (
          <div className="mt-8">
            <h3 className="mb-2 text-sm font-medium">Subscribed devices</h3>
            <p className="mb-4 text-sm text-muted-foreground">
              You are subscribed to notifications on {subscriptions.length} device
              {subscriptions.length !== 1 ? 's' : ''}.
            </p>
            <div className="divide-y">
              {subscriptions.map((sub) => (
                <div key={sub.id} className="flex items-center justify-between py-2">
                  <div className="text-sm">
                    <div>{sub.userAgent || 'Unknown device'}</div>
                    <div className="text-xs text-muted-foreground">
                      <LocalDate iso={sub.createdAt.toISOString()} />
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => handleUnsubscribe(sub.id)}
                    disabled={unsubscribePending}
                  >
                    {unsubscribePending ? 'Removing…' : 'Unsubscribe'}
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
      </form>
    </Form>
  );
}
