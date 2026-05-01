'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { ErrorBanner } from '@/components/forms/ErrorBanner';
import { FormField } from '@/components/forms/FormField';
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

type Props = {
  prefs: NotificationPrefs;
  subscriptions: { id: string; userAgent: string | null; createdAt: Date }[];
};

export function NotificationPrefsForm({ prefs, subscriptions }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [unsubscribePending, setUnsubscribePending] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    setValue,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(notificationPrefsSchema),
    defaultValues: prefs,
  });

  const formError = (errors as { root?: { message?: string } }).root?.message;

  const onSubmit = handleSubmit((data) => {
    setSaveStatus(null);
    startTransition(async () => {
      const result = await saveNotificationPrefs(data);
      if (!result.ok) {
        if (result.formError) setError('root', { message: result.formError });
        if (result.fieldErrors) {
          for (const [field, msgs] of Object.entries(result.fieldErrors)) {
            setError(field as keyof FormValues, { message: msgs?.[0] });
          }
        }
      } else {
        setSaveStatus('Saved.');
      }
    });
  });

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
    <form onSubmit={onSubmit} style={{ maxWidth: 600 }}>
      <ErrorBanner message={formError} />

      <FormField
        label="Push notifications"
        htmlFor="pushEnabled"
        error={errors.pushEnabled?.message}
      >
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
          <input id="pushEnabled" type="checkbox" {...register('pushEnabled')} />
          <span>Enable push notifications</span>
        </label>
      </FormField>

      <FormField
        label="Email notifications"
        htmlFor="emailEnabled"
        error={errors.emailEnabled?.message}
      >
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
          <input id="emailEnabled" type="checkbox" {...register('emailEnabled')} />
          <span>Enable email notifications</span>
        </label>
      </FormField>

      <FormField label="Quiet hours start" htmlFor="quietStart" error={errors.quietStart?.message}>
        <input
          id="quietStart"
          type="time"
          {...register('quietStart', {
            onChange: (e) => {
              if (e.target.value === '') {
                setValue('quietStart', null);
              }
            },
          })}
          style={{ width: '100%' }}
        />
      </FormField>

      <FormField label="Quiet hours end" htmlFor="quietEnd" error={errors.quietEnd?.message}>
        <input
          id="quietEnd"
          type="time"
          {...register('quietEnd', {
            onChange: (e) => {
              if (e.target.value === '') {
                setValue('quietEnd', null);
              }
            },
          })}
          style={{ width: '100%' }}
        />
      </FormField>

      <FormField label="Timezone" htmlFor="timezone" error={errors.timezone?.message}>
        <select id="timezone" {...register('timezone')} style={{ width: '100%' }}>
          {TIMEZONE_OPTIONS.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
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

      {saveStatus && (
        <p style={{ marginTop: '0.4rem', fontSize: '0.85rem', color: 'var(--fg-success)' }}>
          {saveStatus}
        </p>
      )}

      {subscriptions.length > 0 && (
        <div style={{ marginTop: '2rem' }}>
          <h3 style={{ fontSize: '0.95rem', marginBottom: '0.5rem' }}>Subscribed devices</h3>
          <div style={{ fontSize: '0.85rem', color: 'var(--fg-muted)', marginBottom: '1rem' }}>
            You are subscribed to notifications on {subscriptions.length} device
            {subscriptions.length !== 1 ? 's' : ''}.
          </div>
          {subscriptions.map((sub) => (
            <div
              key={sub.id}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '0.5rem 0',
                borderBottom: '1px solid var(--border)',
              }}
            >
              <div style={{ fontSize: '0.85rem' }}>
                <div>{sub.userAgent || 'Unknown device'}</div>
                <div style={{ color: 'var(--fg-muted)', fontSize: '0.75rem' }}>
                  {new Date(sub.createdAt).toLocaleDateString()}
                </div>
              </div>
              <button
                type="button"
                onClick={() => handleUnsubscribe(sub.id)}
                disabled={unsubscribePending}
                style={{
                  padding: '0.25rem 0.75rem',
                  fontSize: '0.85rem',
                  backgroundColor: 'transparent',
                  border: '1px solid var(--border)',
                  borderRadius: '4px',
                  cursor: 'pointer',
                }}
              >
                {unsubscribePending ? 'Removing…' : 'Unsubscribe'}
              </button>
            </div>
          ))}
        </div>
      )}
    </form>
  );
}
