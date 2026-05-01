'use client';
import { useState, useTransition } from 'react';
import { subscribePush } from '@/lib/notifications/actions';

export function PushSubscribeButton() {
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<string | null>(null);

  async function subscribe() {
    setStatus(null);
    startTransition(async () => {
      try {
        if (Notification.permission === 'denied') {
          setStatus('Browser notifications are denied. Enable in your browser site settings.');
          return;
        }
        const perm =
          Notification.permission === 'granted'
            ? 'granted'
            : await Notification.requestPermission();
        if (perm !== 'granted') {
          setStatus('Permission not granted.');
          return;
        }
        const reg = await navigator.serviceWorker.ready;
        const keyRes = await fetch('/api/push/vapid-key');
        if (!keyRes.ok) {
          setStatus('Could not load VAPID key.');
          return;
        }
        const { publicKey } = await keyRes.json();
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
        });
        const json = sub.toJSON();
        const result = await subscribePush({
          endpoint: json.endpoint!,
          p256dh: json.keys!.p256dh!,
          auth: json.keys!.auth!,
          userAgent: navigator.userAgent,
        });
        if (!result.ok) {
          setStatus(result.formError ?? 'Could not save subscription.');
          return;
        }
        setStatus('Subscribed on this device.');
      } catch (e) {
        setStatus((e as Error).message ?? 'Unknown error');
      }
    });
  }

  return (
    <div>
      <button type="button" onClick={subscribe} disabled={pending}>
        {pending ? 'Subscribing…' : 'Subscribe this device'}
      </button>
      {status && (
        <p style={{ marginTop: '0.4rem', fontSize: '0.85rem', color: 'var(--fg-muted)' }}>
          {status}
        </p>
      )}
    </div>
  );
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
