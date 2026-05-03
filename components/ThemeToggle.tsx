'use client';
import { useEffect, useState } from 'react';

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

const buttonBase: React.CSSProperties = {
  padding: '0.25rem 0.75rem',
  fontSize: '0.8125rem',
  cursor: 'pointer',
  border: '1px solid var(--border-strong)',
  background: 'var(--bg-elevated)',
  color: 'var(--fg-muted)',
  lineHeight: 1.4,
};

const buttonActive: React.CSSProperties = {
  ...buttonBase,
  background: 'var(--app-accent)',
  color: 'var(--app-accent-fg)',
  fontWeight: 600,
  borderColor: 'var(--app-accent)',
};

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
      style={{
        display: 'inline-flex',
        borderRadius: '4px',
        overflow: 'hidden',
        border: 'none',
        padding: 0,
        margin: 0,
      }}
    >
      {buttons.map(({ label, value }, i) => {
        const isActive = mounted && mode === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => pick(value)}
            aria-pressed={mounted ? mode === value : undefined}
            style={{
              ...(isActive ? buttonActive : buttonBase),
              borderLeft: i === 0 ? undefined : 'none',
            }}
          >
            {label}
          </button>
        );
      })}
    </fieldset>
  );
}
