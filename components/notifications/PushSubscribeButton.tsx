'use client';
import { Bell, Loader2 } from 'lucide-react';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
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
        // PushSubscriptionJSON types these as optional, but a real
        // PushManager.subscribe() result always has them. Bail loudly if not —
        // calling subscribePush with an empty endpoint or missing keys would
        // silently break notifications down the line.
        if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
          setStatus('Browser returned an incomplete push subscription.');
          return;
        }
        const result = await subscribePush({
          endpoint: json.endpoint,
          p256dh: json.keys.p256dh,
          auth: json.keys.auth,
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
    <div className="space-y-2">
      <Button type="button" variant="outline" onClick={subscribe} disabled={pending}>
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bell className="h-4 w-4" />}
        {pending ? 'Subscribing…' : 'Subscribe this device'}
      </Button>
      {status && <p className="text-sm text-muted-foreground">{status}</p>}
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
