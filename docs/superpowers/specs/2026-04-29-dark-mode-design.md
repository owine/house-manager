# Dark Mode

**Date:** 2026-04-29
**Status:** Draft for review
**Authors:** Oliver Wine (with Claude)
**Parent spec:** `docs/superpowers/specs/2026-04-26-house-manager-design.md`

## Overview

Add a dark/light theme system whose default follows the operating system's `prefers-color-scheme`, with an in-app override (System / Light / Dark) persisted across reloads. No flash-of-wrong-theme on initial render.

This spec was originally scoped to Plan 5 ("polish/design system"). It is being pulled forward as a self-contained piece of work that can land any time after Plan 2a's CRUD lands. It is independent of Plan 2b (attachments), Plan 3 (reminders), and Plan 4 (AI), and should not block them.

## Goals

1. Default to the system theme — a user who has never opened the app and has dark mode set globally sees a dark UI on first paint.
2. Allow an in-app override (System / Light / Dark) that survives reload.
3. No FOUC: the chosen theme applies before the first paint, not after hydration.
4. Establish a minimal token vocabulary (background, foreground, muted, border, accent, danger, focus) that future polish work in Plan 5 can extend without reshuffling.
5. Sweep the existing inline-styled components to read from those tokens, so adding new themes (or tweaking the palette) is a single-file change.

## Non-goals

- A full design system (typography scale, spacing tokens, component library) — that stays in Plan 5.
- Per-component dark mode opt-out — every surface follows the global theme.
- Per-user theme stored server-side — localStorage suffices for v1; cookie sync can come later if Auth.js sessions need it.
- Animated theme transitions — switching is instant.
- Multiple custom palettes (sepia, high-contrast, etc.) — token shape supports it but only two are shipped.

## Architecture

The system has three pieces.

### 1. CSS custom properties on `<html>`

A new `app/globals.css` defines a light palette under `:root` and dark overrides keyed by an attribute. Two selectors are needed:

```css
:root {
  --bg: #ffffff;
  --bg-elevated: #f7f7f7;
  --fg: #111111;
  --fg-muted: #666666;
  --border: #dddddd;
  --border-strong: #999999;
  --accent: #0066cc;
  --accent-fg: #ffffff;
  --danger: #b00020;
  --danger-bg: #fde8e8;
  --focus: #0066cc;
  --badge-bg: #eeeeee;
  --badge-fg: #333333;
  --success: #008800;
  --warning: #cc8800;
}

:root[data-theme="dark"] {
  --bg: #0e0e10;
  --bg-elevated: #1a1a1d;
  --fg: #f0f0f0;
  --fg-muted: #9a9a9a;
  --border: #2a2a2d;
  --border-strong: #444448;
  --accent: #4d9fff;
  --accent-fg: #0e0e10;
  --danger: #ff6b6b;
  --danger-bg: #3a1818;
  --focus: #4d9fff;
  --badge-bg: #2a2a2d;
  --badge-fg: #d0d0d0;
  --success: #66cc66;
  --warning: #e5a050;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    /* same dark overrides as :root[data-theme="dark"] */
  }
}

body {
  background: var(--bg);
  color: var(--fg);
}
```

The `:not([data-theme="light"])` qualifier on the media query lets a user-chosen "Light" override beat a system "dark" preference. The explicit `[data-theme="dark"]` rule lets a user-chosen "Dark" override beat a system "light" preference. When `data-theme` is absent (System mode), the media query takes over.

The exact dark palette will be tuned for AA contrast against `--bg` for `--fg` and `--fg-muted`. Initial values above are starting points, not final.

### 2. No-flash theme script

A small synchronous inline `<script>` in `<head>` reads `localStorage.getItem('theme')` and sets `data-theme` on `<html>` before the first paint. It runs as a string blob (no JSX) inside the Server Component layout so the browser executes it pre-hydration; deferring this to React would mean a brief light-mode flash before the dark theme applies.

The injected JS is a static literal owned by the layout file, with no interpolation of user input — so the standard React-safe pattern for inline scripts applies. It only sets the attribute when the stored value is explicitly `light` or `dark`, so a corrupted or unset value falls through to the media query (System).

```tsx
// app/layout.tsx (sketch)
const themeScript = `
  (function() {
    try {
      var t = localStorage.getItem('theme');
      if (t === 'light' || t === 'dark') {
        document.documentElement.setAttribute('data-theme', t);
      }
    } catch (_) {}
  })();
`;
// rendered in <head> via React's inline-script mechanism so it runs before paint
```

System mode is the absence of `data-theme`. Light mode is `data-theme="light"`. Dark mode is `data-theme="dark"`.

### 3. ThemeToggle Client Component

A small Client Component renders three controls — System / Light / Dark — and writes to both `localStorage` and `document.documentElement.setAttribute` (or `removeAttribute` for System). Mounted in the header of `(app)/layout.tsx` (or wherever the global nav lives) so it's reachable from every authenticated page.

Hydration safety mirrors `ItemListView`: render a deterministic initial state on the server (assume System), resolve the actual stored mode in `useEffect`, then re-render. The button labels can be plain text or simple icons; matching the rest of the app's inline-style aesthetic is fine.

## Token sweep

After the foundation lands, every hard-coded color in existing components is replaced with a `var(--token)` reference. Inventory of files to sweep (current Plan 2a state):

- **Components:** `EmptyState.tsx`, `forms/{ErrorBanner,FormField,SubmitButton}.tsx`, `items/{ItemTable,ItemCardGrid,ItemListView,ItemTabs,ItemForm,ItemMetadataFields}.tsx`, `vendors/{VendorTable,VendorForm}.tsx`, `service-records/{ServiceRecordTable,ServiceRecordForm,ItemAutocomplete,VendorAutocomplete}.tsx`.
- **Pages:** all of `app/(app)/items/**`, `app/(app)/vendors/**`, `app/(app)/service/**`, plus the dashboard, the not-found page, and the auth/error pages.
- **Categories of replacement:**
  - `#fff`, `white` → `var(--bg)`
  - `#f7f7f7`, `#eee` (on light backgrounds) → `var(--bg-elevated)` or `var(--badge-bg)` depending on use
  - `#000`, `black`, `#111` → `var(--fg)`
  - `#666`, `#888` → `var(--fg-muted)`
  - `#ddd`, `#eee` (when used as a border) → `var(--border)`
  - Link blue defaults → `var(--accent)` (set on `a { color: var(--accent) }` globally so individual `<Link>` calls don't need styling)
  - Error red, danger red → `var(--danger)`

Some inline colors (`#000` for active tab borders, `#eee` for table row borders) appear in many files. The sweep is mechanical but must be reviewed file-by-file; a global find-replace will introduce subtle bugs (e.g., border vs background uses of `#eee`).

## Implementation plan

Land as **Plan 2c — Dark mode**, two tasks, after Plan 2a's last commit.

### Task 1 — Foundation

- Create `app/globals.css` with the token definitions above.
- Update `app/layout.tsx`: import the CSS, add the no-flash inline script, ensure `<body>` picks up the body-level color/bg rules.
- Create `components/ThemeToggle.tsx`.
- Mount `<ThemeToggle />` in the authenticated layout (`app/(app)/layout.tsx`) header, alongside whatever sign-out / nav links exist.
- Verify: dev server, toggle through System / Light / Dark, hard reload at each setting confirms the choice applies before paint (no white flash on dark mode).

### Task 2 — Token sweep

- File-by-file replacement of hard-coded colors in the inventory above.
- Add a global `a { color: var(--accent) }` rule in `globals.css` so existing `<Link>` calls pick up the accent color without per-file edits.
- Add `*:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px }` for visible focus in dark mode (default focus rings are invisible against dark backgrounds in some browsers).
- Verify each form, list, detail page in both themes by walking the app manually.

Tests for the token system itself are minimal. A Playwright smoke test that sets `localStorage.theme = 'dark'`, reloads, and screenshots the items list would catch regressions; folding it into the E2E suite (Plan 2a Task 18) is sufficient.

## Open questions

1. **Toggle placement.** Top-right of the global header is conventional. The current app has no global header — `(app)/layout.tsx` is bare. Is this spec also implicitly authorizing the addition of a minimal header, or should the toggle live on `/settings` only?
2. **System mode + cross-tab sync.** If the user picks "System" in tab A and the OS theme changes, the running tab needs a `matchMedia(...).addEventListener('change', ...)` handler to refresh styles without reload. Worth doing in Task 1 or defer?
3. **Accessibility floor.** Should the dark palette target WCAG AA (4.5:1 body contrast) or AAA (7:1)? AA is achievable with the starting palette; AAA needs more careful tuning.

## Risks

- **Sweep coverage.** Easy to miss an inline color in a less-used file (error pages, not-found). Mitigation: grep for hex literals (`grep -rn "#[0-9a-fA-F]\{3,6\}" app components`) at the end of Task 2.
- **rehype-sanitize default styles.** Markdown rendered via the `<Markdown>` component inherits ambient text color, which works automatically. But code blocks and blockquotes may need explicit `var(--badge-bg)` / `var(--border)` to stay legible in both themes — check during sweep.
- **Plan 2a deltas.** This spec inventories the files that exist as of commit `6382f8f`. Any new components added later in Plan 2a (Warranties, Notes, Settings, Dashboard) will need to be theme-aware from the start, or appear as additional sweep targets when this plan executes.
