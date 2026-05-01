'use client';
import { useEffect } from 'react';

export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch((e) => {
        console.warn('SW registration failed', e);
      });
    }
  }, []);
  return null;
}
