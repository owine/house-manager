'use client';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

type Mode = 'system' | 'light' | 'dark';
const STORAGE_KEY = 'theme';

function readMode(): Mode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {
    // localStorage unavailable (e.g. private browsing with storage disabled)
  }
  return 'system';
}

function applyMode(mode: Mode): void {
  const root = document.documentElement;
  if (mode === 'system') {
    root.removeAttribute('data-theme');
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  } else {
    root.setAttribute('data-theme', mode);
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // ignore
    }
  }
}

export function ThemeToggle() {
  // Render a stable initial state ('system') on the server; resolve real mode
  // in useEffect. The no-flash script in layout.tsx already set data-theme
  // correctly before hydration, so this effect just syncs the toggle's visual
  // state.
  const [mode, setMode] = useState<Mode>('system');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMode(readMode());
    setMounted(true);
  }, []);

  function pick(next: Mode) {
    applyMode(next);
    setMode(next);
  }

  const buttons: { label: string; value: Mode }[] = [
    { label: 'System', value: 'system' },
    { label: 'Light', value: 'light' },
    { label: 'Dark', value: 'dark' },
  ];

  return (
    <fieldset
      aria-label="Color theme"
      className="m-0 inline-flex overflow-hidden rounded-md border-0 p-0"
    >
      {buttons.map(({ label, value }, i) => {
        const isActive = mounted && mode === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => pick(value)}
            aria-pressed={mounted ? mode === value : undefined}
            className={cn(
              'cursor-pointer border border-border px-3 py-1 text-xs leading-tight transition-colors',
              i !== 0 && 'border-l-0',
              isActive
                ? 'bg-primary font-semibold text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-muted/80',
            )}
          >
            {label}
          </button>
        );
      })}
    </fieldset>
  );
}
