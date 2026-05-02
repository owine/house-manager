# Plan 4ab — UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ad-hoc inline-styled UI with Tailwind v4 + shadcn/ui (20 primitives), add a persistent left sidebar nav, and migrate all 10 existing routes onto 4 shared page-template shells.

**Architecture:** Tailwind v4 (CSS-first, no config file) layered on the existing `light-dark()` theme tokens via `@theme` mapping. shadcn/ui primitives copied into `components/ui/`. Sidebar chrome in `app/(app)/layout.tsx` via shadcn `<Sidebar>`. Four shared shells (`<ListPageShell>`, `<DetailPageShell>`, `<DashboardShell>`, `<FormPageShell>`) plus `<PageHeader>` consumed by every route.

**Tech Stack:** Next.js 16, TypeScript 6, Tailwind 4.2.4, `@tailwindcss/postcss` 4.2.4, shadcn-cli 4.6.0 (preset `base-nova` → `@base-ui/react`), `lucide-react`, RHF 7, Zod 4. Existing: Prisma 7, Auth.js v5, Meilisearch 1.42, pg-boss 12.

---

## Task 0: Pre-flight greps (no commit)

Take 5 minutes to locate the existing patterns this plan depends on. Doing it once up front saves context-switching mid-task.

- [ ] **Existing CSS tokens & inline-style scope**: `grep -rn "var(--" app/ components/ lib/ | wc -l` should report ~40 files. `grep -rln "style=" app/ components/ | wc -l` should report ~56 files. These numbers gauge migration size; if they're wildly different from plan-writing-time you're either on the wrong branch or the codebase has shifted significantly.

- [ ] **Existing `--accent` usages**: `grep -rn "var(--accent)\|--accent\b" app/ components/ lib/`. Should be 6 hits across `app/globals.css` (the definition) and `components/ThemeToggle.tsx` (the consumer). Task 1 renames `--accent` to `--app-accent` to avoid colliding with shadcn's expected `--accent` namespace; these are the only references that need updating.

- [ ] **Existing layout chrome**: read `app/(app)/layout.tsx`. It's the SOLE auth gate (per the comment block at the top — middleware was removed in Plan 1). Task 5 rewrites this file's render tree but the `auth() / redirect` gate at the top stays untouched.

- [ ] **EmptyState component shape**: `cat components/EmptyState.tsx`. Confirm its current props before Task 22's restyling task touches it. Plan assumes the existing API (`title`, `description`, `action`) is preserved; verify.

- [ ] **Form helpers**: `ls components/forms/ lib/forms/ 2>/dev/null` and `grep -rln "useForm\b" app/ components/ | head -10`. Identify the existing RHF pattern. Task 14 creates `lib/forms/helpers.ts` with `applyActionFieldErrors`; verify this file doesn't already exist (the spec assumes it doesn't).

- [ ] **shadcn-cli currency**: `pnpm view shadcn version`. Should be 4.6.x or later. If a major has shipped since plan-writing, read its release notes — this plan was written against 4.6.0.

- [ ] **PR #23 status** (`gh pr view 23` if installed, or check the GitHub UI): the env-vars-readme PR contains a refresh of `docs/README.md`'s "Plans status" section. **This plan's Task 1 also touches that section.** If PR #23 is merged when you start: rebase this branch onto main first; the README change conflict is one-line and trivially resolvable. If PR #23 is still open: coordinate the merge order — either land #23 first then rebase (preferred), or land 4ab first and #23 absorbs the new ordering on rebase.

Note any deltas from this plan's assumptions in your scratch notes — they'll come up again later.

---

## Conventions for the implementer

These are project conventions enforced across every task. Don't deviate without flagging.

- **Commits**: signed via 1Password (just `git commit` — no `-c user.email=`, no `--no-verify`, no `--no-gpg-sign`). Stage explicit paths, never `git add -A`. Conventional-commits subject prefixes (`feat(ui):`, `refactor(ui):`, `chore(ui):`, `feat(deps):`, etc.).
- **Push cadence**: branch accumulates commits across all tasks; push happens at the end via `superpowers:finishing-a-development-branch`. Branch is already `plan-4ab-ui-redesign`, off main, with the spec committed across 4 commits.
- **Combined Haiku reviewer per task** after implementation, per `feedback_execution_cadence` memory.
- **Dependency pinning**: every new dep uses `~` (patch-level) range per `feedback_dep_pinning`. Run `pnpm view <pkg>@latest version` before adding to confirm currency (per `feedback_dep_currency`). The new deps in this plan: `tailwindcss@~4.2.4`, `@tailwindcss/postcss@~4.2.4`, plus the deps shadcn-cli pulls in (`@base-ui/react`, `lucide-react`, `class-variance-authority`, `clsx`, `tailwind-merge`, `tw-animate-css`, possibly more — verify each lands at a `~`-pinned range after init runs).
- **No new env vars in this plan.** No CI / Dockerfile / docker-compose changes needed.
- **Module-load DATABASE_URL trap** (n/a for this plan — no test code touches `lib/db` from a static import; tests stay as they are).
- **Auth pattern** (n/a directly, but Task 5 references it): `auth()` from `@/lib/auth`, not `requireSession()`.
- **`light-dark()` is the source of truth.** Don't write parallel `.dark { ... }` selectors — `light-dark()` resolves both. The existing `[data-theme]` overrides on `:root` keep working.
- **shadcn primitives are owned source.** `components/ui/*.tsx` files are part of this repo, not a dep. If a primitive needs a tweak (different default variant, project-specific override), edit the file. Don't fork into a wrapper unless the change is composition (e.g., a `<ConfirmDialog>` that uses `<Dialog>` + custom buttons).
- **Inline `style={{ }}` is FORBIDDEN in new and migrated code.** If you find yourself reaching for it during a migration task, stop — there's a missing token, missing utility class, or missing primitive. Open a flag in the task report.
- **Visual verification is mandatory for migration tasks.** Type-check + lint pass is necessary but not sufficient. Run `pnpm dev`, navigate to the migrated route, eyeball it in light AND dark mode (`<ThemeToggle>` in the sidebar footer once Task 4 lands; until then, system-pref toggle in OS).
- **E2E suite is the safety net.** The Playwright tests in `tests/e2e/` use accessible role queries (`getByRole`, `getByText`) which mostly survive the migration. Each migration task ends with `pnpm test:e2e tests/e2e/<area>.spec.ts` if a relevant spec exists. Tests that target inline `style` attributes WILL break; flag them in the task report.

---

## File structure (this plan creates / modifies)

```
postcss.config.mjs                                          # CREATED Task 2
components.json                                             # CREATED Task 2 (by shadcn init)
app/globals.css                                             # HEAVILY MODIFIED Task 1+2

components/ui/                                              # CREATED Task 2-3 (shadcn-cli)
  button.tsx, card.tsx, input.tsx, textarea.tsx, label.tsx,
  form.tsx, select.tsx, checkbox.tsx, switch.tsx, dialog.tsx,
  dropdown-menu.tsx, tabs.tsx, table.tsx, badge.tsx,
  sidebar.tsx, sheet.tsx, separator.tsx, tooltip.tsx,
  avatar.tsx, sonner.tsx, skeleton.tsx                      # 21 files, all owned source

lib/utils.ts                                                # CREATED Task 2 (by shadcn init; cn() helper)
lib/forms/helpers.ts                                        # CREATED Task 14 (applyActionFieldErrors)

app/(app)/_components/                                      # CREATED Task 4-10
  AppSidebar.tsx                                            # Task 4
  PageHeader.tsx                                            # Task 6
  ListPageShell.tsx                                         # Task 7
  DetailPageShell.tsx                                       # Task 8
  DashboardShell.tsx                                        # Task 9
  FormPageShell.tsx                                         # Task 10

app/(app)/layout.tsx                                        # MODIFIED Task 5 (sidebar integration)

app/(app)/dashboard/                                        # MIGRATED Task 11
app/(app)/items/page.tsx                                    # MIGRATED Task 12
app/(app)/items/[id]/page.tsx                               # MIGRATED Task 13
app/(app)/items/new/page.tsx                                # MIGRATED Task 14
app/(app)/items/[id]/edit/page.tsx                          # MIGRATED Task 15
app/(app)/settings/                                         # MIGRATED Task 16
app/(app)/vendors/                                          # MIGRATED Task 17
app/(app)/reminders/                                        # MIGRATED Task 18
app/(app)/notes/                                            # MIGRATED Task 19
app/(app)/search/                                           # MIGRATED Task 20
app/(app)/service/, app/(app)/warranties/                   # MIGRATED Task 21

components/{items,vendors,notes,reminders,...}/             # MIGRATED Tasks 11-21 alongside their pages

components/EmptyState.tsx                                   # MODIFIED Task 22 (restyled to use shadcn primitives)
components/ThemeToggle.tsx                                  # MODIFIED Task 1 (--accent rename) + Task 4 (mounted in sidebar footer)
components/items/ItemTable.tsx                              # DELETED Task 22

docs/README.md                                              # MODIFIED Task 1 (plans-status update)
docs/superpowers/plans/2026-05-01-plan-4b-suggest.md        # MODIFIED Task 23 (Plan 4b amendment)
```

---

## Task 1: Rename `--accent` → `--app-accent` + README plans-status update

**Files:**
- Modify: `app/globals.css`
- Modify: `components/ThemeToggle.tsx`
- Modify: `docs/README.md`

This task runs BEFORE any tooling installation. The rename clears the namespace collision so `shadcn init` (Task 2) doesn't overwrite our existing `--accent` value with shadcn's neutral-gray default.

- [ ] **Step 1: Confirm PR #23 merge status**

```bash
gh pr view 23 --json state --jq .state
```

If `MERGED`: rebase this branch onto main first (`git rebase main`). The README change in Task 1 Step 4 below will need a different starting state — read the current `docs/README.md` to confirm the new ordering before editing.

If `OPEN`: continue. Be aware that PR #23 also touches `docs/README.md`'s plans-status section. When this plan's branch goes for review, rebase or merge-resolve as needed.

If `CLOSED` (not merged): consult the PR conversation; the env-vars-readme work may have moved elsewhere.

- [ ] **Step 2: Rename `--accent` definitions in `app/globals.css`**

Find these two lines in `:root` (around line 19-20):

```css
  --accent: light-dark(#0066cc, #4d9fff);
  --accent-fg: light-dark(#ffffff, #0e0e10);
```

Rename to:

```css
  --app-accent: light-dark(#0066cc, #4d9fff);
  --app-accent-fg: light-dark(#ffffff, #0e0e10);
```

Find the `a { color: var(--accent); }` rule (around line 51) and update to `var(--app-accent)`.

- [ ] **Step 3: Update consumers in `components/ThemeToggle.tsx`**

`grep -n "var(--accent)" components/ThemeToggle.tsx` should show 3 hits (lines 48, 49, 51 or similar). Replace each `var(--accent)` with `var(--app-accent)` and each `var(--accent-fg)` with `var(--app-accent-fg)`.

- [ ] **Step 4: Verify no other consumers**

```bash
grep -rn "var(--accent)\|var(--accent-fg)\|--accent\b" app/ components/ lib/
```

Expected output: only matches inside `app/globals.css` (definitions of `--app-accent`/`--app-accent-fg`). If anything else matches, update it.

- [ ] **Step 5: Update `docs/README.md` plans-status**

Replace the existing plans-status block (around line 62-68) with:

```markdown
## Plans status

- [x] Plan 1: Foundation
- [x] Plan 2a: Core CRUD entities
- [x] Plan 2b: Attachments / file uploads
- [x] Plan 2c: Attachment links
- [x] Plan 3: Reminders, Web Push, email, iCal feed
- [x] Plan 4a: Find — Meilisearch keyword search
- [ ] Plan 4ab: UI redesign — design system, navigation, page templates (this plan)
- [ ] Plan 4b: Suggest — AI structured generation (paused at schema migration; resumes after 4ab)
- [ ] Plan 4c: Ask — RAG over user documents + OCR
- [ ] Plan 5: Polish & Operations
```

If PR #23 already merged some of these checkboxes, just add the 4ab line and adjust 4b's annotation.

- [ ] **Step 6: Verify the app still builds**

```bash
pnpm build
# Expected: success. The rename is purely cosmetic for the codebase since
# nothing is consuming --accent yet from outside ThemeToggle.
```

- [ ] **Step 7: Commit**

```bash
git add app/globals.css components/ThemeToggle.tsx docs/README.md
git commit -m "refactor(ui): rename --accent to --app-accent + slot 4ab in roadmap"
```

---

## Task 2: Foundation — Tailwind v4 + shadcn init + theme mapping

**Files:**
- Create: `postcss.config.mjs`
- Create: `components.json` (by shadcn init)
- Create: `lib/utils.ts` (by shadcn init)
- Create: `components/ui/button.tsx` (by shadcn init)
- Modify: `package.json`, `pnpm-lock.yaml`
- Heavily modify: `app/globals.css`

This is the foundation task. End state: `pnpm build` succeeds, dashboard renders with sans-serif headings (visible improvement, verifies the layer works), and theme tokens are mapped end-to-end.

- [ ] **Step 1: Verify dep currency**

```bash
pnpm view tailwindcss version
pnpm view @tailwindcss/postcss version
pnpm view shadcn version
```

Expected: tailwindcss ≥ 4.2.x, postcss plugin matches, shadcn ≥ 4.6.0. Per `feedback_dep_currency`. Plan was written against tailwind 4.2.4 + shadcn 4.6.0; if a major has shipped, read release notes.

- [ ] **Step 2: Install Tailwind v4 + PostCSS plugin**

```bash
pnpm add -D tailwindcss@latest @tailwindcss/postcss@latest
```

After install, edit `package.json` so the lines use `~` not `^`:

```jsonc
"tailwindcss": "~4.2.4",
"@tailwindcss/postcss": "~4.2.4"
```

- [ ] **Step 3: Create `postcss.config.mjs`**

```mjs
const config = {
  plugins: ['@tailwindcss/postcss'],
};
export default config;
```

- [ ] **Step 4: Add Tailwind import to `globals.css`**

Prepend `@import "tailwindcss";` as the very first line of `app/globals.css`, before the existing comment block.

- [ ] **Step 5: Verify Tailwind compiles**

```bash
pnpm build
# Expected: success. No visual changes yet — Tailwind classes aren't used anywhere
# in the codebase; we just verified the toolchain.
```

- [ ] **Step 6: Run shadcn init**

```bash
pnpm dlx shadcn@latest init -d -y --css-variables
```

Expected output:
- `Validating Tailwind CSS. ✔` (because Step 2-4 set it up)
- `Writing components.json. ✔`
- `Installing dependencies. ✔` (pulls in `@base-ui/react`, `class-variance-authority`, `clsx`, `tailwind-merge`, `tw-animate-css`, `lucide-react`, etc.)
- `Created 2 files: components/ui/button.tsx, lib/utils.ts ✔`
- `Updating app/globals.css ✔`

If `Validating Tailwind CSS ✖`: something went wrong with Steps 2-5. Stop and debug before continuing.

- [ ] **Step 7: Verify `components.json` is v4-correct**

```bash
cat components.json
```

Required fields:
- `"tailwind.config": ""` (empty — confirms v4 no-config-file mode)
- `"tailwind.cssVariables": true`
- `"style": "base-nova"` (or `"new-york"` / `"default"` — note the value)
- `"aliases.ui": "@/components/ui"`

If `"tailwind.config"` has a path filled in, you got the v3 detection path; this plan was specced for v4. Stop and debug.

- [ ] **Step 8: Pin shadcn-installed deps to `~`**

The shadcn init pulled in several deps with `^` ranges. Edit `package.json` so each new line uses `~`:
- `@base-ui/react`
- `class-variance-authority`
- `clsx`
- `lucide-react`
- `tailwind-merge`
- `tw-animate-css`

(The exact list depends on shadcn-cli's version. `git diff package.json` to see what got added; convert all `^` to `~`.)

Run `pnpm install` after editing to update the lockfile to the patch-pinned ranges.

- [ ] **Step 9: Post-init cleanup of `app/globals.css`**

shadcn init injected light-only `oklch()` versions of variables that collide with our `light-dark()` token names. Open `app/globals.css` and:

**(a) Remove the shadcn-injected light-only variable block.** Look for lines like:

```css
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.145 0 0);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.145 0 0);
  --primary: oklch(0.205 0 0);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.97 0 0);
  --secondary-foreground: oklch(0.205 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --accent: oklch(0.97 0 0);
  --accent-foreground: oklch(0.205 0 0);
  --destructive: oklch(0.577 0.245 27.325);
  --input: oklch(0.922 0 0);
  --ring: oklch(0.708 0 0);
```

Delete all of these. They sit inside `:root { ... }` near where the existing `--bg`/`--fg`/etc. tokens live. They have no dark counterparts; we don't want them.

**(b) Restore `--border`** if init overwrote it. The existing line should be:

```css
  --border: light-dark(#dddddd, #2a2a2d);
```

If it now reads `--border: oklch(0.922 0 0);`, restore the `light-dark()` form.

**(c) Confirm `--accent` is `--app-accent`** per Task 1. shadcn init may have re-introduced an `--accent` line; if so, delete it (we mapped `--color-accent` to `var(--bg-elevated)` for hover fills via `@theme` in step 10).

- [ ] **Step 10: Add the `@theme` mapping block**

Append to `app/globals.css` (after the `:root { ... }` token block, before the existing utility classes):

```css
@theme {
  /* Surfaces */
  --color-background: var(--bg);
  --color-foreground: var(--fg);
  --color-card: var(--bg);
  --color-card-foreground: var(--fg);
  --color-popover: var(--bg-elevated);
  --color-popover-foreground: var(--fg);
  --color-muted: var(--bg-elevated);
  --color-muted-foreground: var(--fg-muted);

  /* Interactive */
  --color-primary: var(--app-accent);
  --color-primary-foreground: var(--app-accent-fg);
  --color-secondary: var(--bg-elevated);
  --color-secondary-foreground: var(--fg);
  --color-accent: var(--bg-elevated);
  --color-accent-foreground: var(--fg);

  /* Status */
  --color-destructive: var(--danger);
  --color-destructive-foreground: #ffffff;

  /* Borders + focus */
  --color-border: var(--border);
  --color-input: var(--border);
  --color-ring: var(--focus);

  /* Typography + radius */
  --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Inter, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  --radius: 0.5rem;
}
```

- [ ] **Step 11: Set the body font-family**

Find the existing `body { ... }` rule in `app/globals.css` (around line 41 in pre-edit numbering) and add the font-family:

```css
body {
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-sans);
}
```

This single change fixes the serif-by-default heading bug. After this step, headings like `<h1>Hello, owine</h1>` on the dashboard render in sans-serif.

- [ ] **Step 12: Verify build + render**

```bash
pnpm typecheck
pnpm build
pnpm dev
```

Open `http://localhost:3000/dashboard` — the "Hello, X" heading should now be sans-serif. Toggle theme via the existing `<ThemeToggle>` (it's in `components/ThemeToggle.tsx`, currently unrendered — we'll mount it via the sidebar in Task 4. For now, manually toggle OS theme to verify dark mode tokens still resolve).

If anything looks broken in dark mode (text on a light background, missing fills, etc.), revisit Step 9 — likely an oklch variable wasn't fully removed, or `@theme` is missing a mapping.

- [ ] **Step 13: Smoke-test `<Button>`**

The default `<Button>` from `components/ui/button.tsx` is already installed by shadcn init. Mount it temporarily to verify Tailwind classes resolve correctly:

Open `app/(app)/dashboard/page.tsx` and inside the existing return JSX, somewhere visible, add:

```tsx
import { Button } from '@/components/ui/button';
// inside return:
<Button>Test button</Button>
<Button variant="secondary">Secondary</Button>
<Button variant="outline">Outline</Button>
<Button variant="destructive">Destructive</Button>
```

Reload `/dashboard`. The four buttons should render with shadcn's default neutral styling — distinct fill colors, hover states work in both light and dark theme.

If any button renders unstyled or with broken hover (transparent background, no fill change on hover), the `@theme` block in Step 10 is missing a token. Re-check.

After confirmation, **delete** the test buttons. They were just smoke-test verification.

- [ ] **Step 14: Commit**

```bash
git add postcss.config.mjs components.json lib/utils.ts components/ui/button.tsx \
        app/globals.css package.json pnpm-lock.yaml app/(app)/dashboard/page.tsx
git commit -m "feat(ui): Tailwind v4 + shadcn init + @theme mapping over light-dark() tokens"
```

(The dashboard/page.tsx file is in the staged set only because we removed our smoke-test buttons; verify with `git diff --cached` that no unintended dashboard changes leaked.)

---

## Task 3: Install remaining shadcn primitives (19 of 20)

**Files:**
- Create (each): `components/ui/<name>.tsx`

`<Button>` is already in from Task 2's init. The remaining 19 primitives are installed one shadcn-cli `add` command each.

- [ ] **Step 1: Install in groups by dependency**

shadcn-cli sometimes silently skips transitive deps; we install in dependency order so each `add` command's deps are already present.

```bash
# Foundation surfaces
pnpm dlx shadcn@latest add card input textarea label badge separator skeleton

# Inputs
pnpm dlx shadcn@latest add select checkbox switch

# Overlays
pnpm dlx shadcn@latest add tooltip dialog sheet dropdown-menu

# Forms (depends on label, input — already installed above)
pnpm dlx shadcn@latest add form

# Containers
pnpm dlx shadcn@latest add tabs table avatar

# Toast (separate package; shadcn wraps Sonner)
pnpm dlx shadcn@latest add sonner

# Sidebar (depends on sheet, separator, tooltip — all above)
pnpm dlx shadcn@latest add sidebar
```

If any individual command fails (network, registry hiccup), retry that one.

- [ ] **Step 2: Verify all 21 primitive files exist**

(20 from the install set + button.tsx from init. We also installed `skeleton.tsx` for loading states, not in the original install set — adds one to the count = 21.)

```bash
ls components/ui/
```

Expected files:
```
avatar.tsx     button.tsx     dialog.tsx          form.tsx     separator.tsx  sonner.tsx     textarea.tsx
badge.tsx      card.tsx       dropdown-menu.tsx   input.tsx    sheet.tsx      switch.tsx     tooltip.tsx
checkbox.tsx   label.tsx      select.tsx          sidebar.tsx  skeleton.tsx   table.tsx      tabs.tsx
```

If any are missing, re-run their `add` command.

- [ ] **Step 3: Pin newly-installed transitive deps**

`git diff package.json` — any new dependency lines added by the cumulative `add` commands? Common new pulls: `@base-ui/react/select`, `@base-ui/react/dialog`, `@base-ui/react/checkbox`, `@base-ui/react/switch`, `@base-ui/react/dropdown`, `@base-ui/react/tabs`, `@base-ui/react/tooltip`, `cmdk` (used by some primitives), etc. Convert all `^` to `~` and run `pnpm install` to update the lockfile.

- [ ] **Step 4: Typecheck**

```bash
pnpm typecheck
```

Expected: no errors. Each primitive imports cleanly. If a primitive complains about a missing import (often a missing transitive Radix/base-ui module), look at its imports and `pnpm add` the missing package directly.

- [ ] **Step 5: Commit**

```bash
git add components/ui package.json pnpm-lock.yaml
git commit -m "feat(ui): install 19 remaining shadcn primitives"
```

---

## Task 4: AppSidebar component (no AppLayout integration yet)

**Files:**
- Create: `app/(app)/_components/AppSidebar.tsx`

Build the sidebar in isolation first; Task 5 wires it into the AppLayout. This separation lets the sidebar render in a temporary `_dev` route for visual eyeball before disturbing the main layout.

- [ ] **Step 1: Read shadcn `<Sidebar>` API**

```bash
cat components/ui/sidebar.tsx | head -80
```

Note the exported names: `Sidebar`, `SidebarProvider`, `SidebarTrigger`, `SidebarContent`, `SidebarGroup`, `SidebarGroupLabel`, `SidebarGroupContent`, `SidebarMenu`, `SidebarMenuItem`, `SidebarMenuButton`, `SidebarFooter`, `SidebarRail`, etc. The sidebar must be wrapped in `<SidebarProvider>` (Task 5 does this in the layout).

- [ ] **Step 2: Implement `AppSidebar`**

Create `app/(app)/_components/AppSidebar.tsx`:

```tsx
'use client';

import {
  Calendar,
  CheckSquare,
  Home,
  ListChecks,
  Package,
  Search,
  Settings,
  Shield,
  StickyNote,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ThemeToggle } from '@/components/ThemeToggle';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from '@/components/ui/sidebar';

type NavItem = { href: string; label: string; icon: React.ComponentType<{ className?: string }> };

const PRIMARY: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: Home },
  { href: '/items', label: 'Items', icon: Package },
  { href: '/vendors', label: 'Vendors', icon: Users },
  { href: '/reminders', label: 'Reminders', icon: Calendar },
  { href: '/checklists', label: 'Checklists', icon: ListChecks },  // Plan 4b adds the routes; the link is harmless until then
  { href: '/notes', label: 'Notes', icon: StickyNote },
  { href: '/search', label: 'Search', icon: Search },
];

function isActive(pathname: string, href: string): boolean {
  if (href === '/dashboard') return pathname === '/dashboard';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppSidebar({ user }: { user: { name?: string | null; role?: string | null } }) {
  const pathname = usePathname();
  const isAdmin = user.role === 'ADMIN';

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <Link href="/dashboard" className="flex items-center gap-2 px-2 py-1.5 font-semibold">
          <span className="text-base">House Manager</span>
        </Link>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {PRIMARY.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton asChild isActive={isActive(pathname, item.href)} tooltip={item.label}>
                    <Link href={item.href}>
                      <item.icon className="h-4 w-4" />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator />

        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={isActive(pathname, '/settings')} tooltip="Settings">
                  <Link href="/settings">
                    <Settings className="h-4 w-4" />
                    <span>Settings</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {isAdmin && (
                <SidebarMenuItem>
                  <SidebarMenuButton asChild isActive={isActive(pathname, '/admin')} tooltip="Admin">
                    <Link href="/admin">
                      <Shield className="h-4 w-4" />
                      <span>Admin</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <ThemeToggle />
        <div className="px-2 py-1.5 text-xs text-muted-foreground">Signed in as {user.name ?? 'user'}</div>
      </SidebarFooter>
    </Sidebar>
  );
}
```

(If shadcn's `<SidebarSeparator>` has a different name in your installed version, `grep -E "export.*Separator" components/ui/sidebar.tsx` to find it.)

- [ ] **Step 3: Typecheck**

```bash
pnpm typecheck
```

If complaints about `usePathname` type or `lucide-react` icons being missing, those are dep issues — verify Task 3 Step 3 actually pinned everything.

- [ ] **Step 4: No commit yet**

This file isn't rendered anywhere — Task 5 wires it. Hold the working-tree change; Task 5's commit will include `AppSidebar.tsx`.

---

## Task 5: AppLayout integration + Sonner toaster

**Files:**
- Modify: `app/(app)/layout.tsx`

End state: every existing page renders inside the new sidebar chrome. Page bodies are still inline-styled (migration starts in Task 11) but the chrome is real.

- [ ] **Step 1: Read existing `app/(app)/layout.tsx`**

```bash
cat app/\(app\)/layout.tsx
```

Note the `auth() / redirect` block at the top — that's the sole auth gate per Plan 1's commit message. Keep it identical.

- [ ] **Step 2: Rewrite the return JSX to use SidebarProvider + AppSidebar**

Replace the existing `<div>...<header>...</header><main>{children}</main>...</div>` shape with:

```tsx
import { redirect } from 'next/navigation';
import { ServiceWorkerRegistrar } from '@/components/notifications/ServiceWorkerRegistrar';
import { SearchBar } from '@/components/search/SearchBar';
import { Toaster } from '@/components/ui/sonner';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { auth } from '@/lib/auth';
import { AppSidebar } from './_components/AppSidebar';

// SOLE AUTH GATE for the application (per Plan 1 - middleware was removed
// in Task 12 to avoid Auth.js v5 JWE-vs-database-session incompatibility).
// Protected pages must live under this route group `app/(app)/` to inherit
// the redirect below.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect('/api/auth/signin');

  return (
    <SidebarProvider>
      <AppSidebar user={{ name: session.user.name, role: session.user.role }} />
      <SidebarInset>
        <header className="flex h-14 items-center gap-2 border-b px-4">
          <SidebarTrigger />
          <div className="flex-1">
            <SearchBar />
          </div>
        </header>
        <main className="p-6">{children}</main>
      </SidebarInset>
      <Toaster />
      <ServiceWorkerRegistrar />
    </SidebarProvider>
  );
}
```

Notes:
- `<Toaster />` from `@/components/ui/sonner` mounts the toast root. One mount per app.
- `<SidebarInset>` is the right-of-sidebar main content wrapper (provides correct sizing + responsive collapse).
- The `<header>` collapses to `h-14` (56px) — matches shadcn's typical chrome height.
- The "Signed in as X" text moved from the header to the sidebar footer (per Q3 of brainstorming).

- [ ] **Step 3: Typecheck + build**

```bash
pnpm typecheck
pnpm build
```

If `session.user.role` triggers a type error: the existing `lib/auth.ts` extends the session user type with `role`. Confirm `grep -n "role" lib/auth.ts` shows the augmentation; if not, the AppSidebar type needs adjustment (set `role?: string | null` and accept it'll be undefined for non-augmented sessions).

- [ ] **Step 4: Eyeball every existing route**

```bash
pnpm dev
```

Visit each in order — the page bodies will look unchanged (still inline-styled), but the sidebar should be present on every one:

- `/dashboard`
- `/items` — list still card-grid-styled inline; sidebar wraps it
- `/items/[id]` — pick any seeded item id from `psql` if needed
- `/items/new`
- `/vendors`
- `/reminders`
- `/notes`
- `/search`
- `/settings`

Verify:
- Sidebar shows all 7 primary items + Settings (+ Admin if your role is ADMIN).
- Active state lights up the current page.
- Sidebar trigger toggles collapse on desktop.
- Resize the viewport to <768px (mobile) — sidebar collapses to a sheet behind the hamburger.
- Theme toggle in sidebar footer still flips light/dark.

If any route 500s after this change, the most likely culprit is a Server Component trying to access `session.user.role` where it wasn't typed before. Each page imports `auth` independently, so the type augmentation should propagate; but if not, fix the offending route's auth call.

- [ ] **Step 5: Run E2E suite**

```bash
pnpm test:e2e
```

Most tests should pass — they use accessible role queries that survive structural changes. Flag any failure that's clearly a structural issue (e.g., a test expects a specific `<header>` shape).

- [ ] **Step 6: Commit**

```bash
git add app/\(app\)/_components/AppSidebar.tsx app/\(app\)/layout.tsx
git commit -m "feat(ui): sidebar chrome (AppSidebar + AppLayout integration + Toaster)"
```

---

## Task 6: `<PageHeader>` shared component

**Files:**
- Create: `app/(app)/_components/PageHeader.tsx`

Single source of truth for page titles, descriptions, primary actions. Used by all four shells in Tasks 7-10.

- [ ] **Step 1: Implement**

```tsx
// app/(app)/_components/PageHeader.tsx

type Props = {
  title: string;
  description?: string;
  actions?: React.ReactNode;
};

export function PageHeader({ title, description, actions }: Props) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm typecheck
```

- [ ] **Step 3: Commit**

```bash
git add app/\(app\)/_components/PageHeader.tsx
git commit -m "feat(ui): PageHeader shared component"
```

---

## Task 7: `<ListPageShell>` shared component

**Files:**
- Create: `app/(app)/_components/ListPageShell.tsx`

- [ ] **Step 1: Implement**

```tsx
// app/(app)/_components/ListPageShell.tsx

type Props = {
  header: React.ReactNode;     // <PageHeader />
  filters?: React.ReactNode;
  empty?: React.ReactNode;     // shown when isEmpty is true
  isEmpty?: boolean;
  children: React.ReactNode;   // the list content
};

export function ListPageShell({ header, filters, empty, isEmpty, children }: Props) {
  return (
    <div className="mx-auto max-w-7xl">
      {header}
      {filters && <div className="mb-4">{filters}</div>}
      {isEmpty && empty ? empty : children}
    </div>
  );
}
```

The `isEmpty` prop is explicit (caller decides) — better than trying to introspect children for "is the list empty," which is brittle.

- [ ] **Step 2: Commit**

```bash
git add app/\(app\)/_components/ListPageShell.tsx
git commit -m "feat(ui): ListPageShell"
```

---

## Task 8: `<DetailPageShell>` shared component

**Files:**
- Create: `app/(app)/_components/DetailPageShell.tsx`

- [ ] **Step 1: Implement**

```tsx
// app/(app)/_components/DetailPageShell.tsx
'use client';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

type Tab = {
  value: string;
  label: string;
  content: React.ReactNode;
};

type Props = {
  header: React.ReactNode;     // <PageHeader />
  meta?: React.ReactNode;      // sidebar-style summary card (right column on desktop)
  tabs: Tab[];
  defaultTab?: string;         // defaults to first tab's value
};

export function DetailPageShell({ header, meta, tabs, defaultTab }: Props) {
  return (
    <div className="mx-auto max-w-7xl">
      {header}
      <div className="grid gap-6 md:grid-cols-3">
        <div className="md:col-span-2">
          <Tabs defaultValue={defaultTab ?? tabs[0]?.value}>
            <TabsList>
              {tabs.map((t) => (
                <TabsTrigger key={t.value} value={t.value}>
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {tabs.map((t) => (
              <TabsContent key={t.value} value={t.value}>
                {t.content}
              </TabsContent>
            ))}
          </Tabs>
        </div>
        {meta && <aside className="md:col-span-1">{meta}</aside>}
      </div>
    </div>
  );
}
```

The `'use client'` is needed because `<Tabs>` from shadcn uses client-side state. Pages still server-render their content; only this shell is a client boundary.

- [ ] **Step 2: Commit**

```bash
git add app/\(app\)/_components/DetailPageShell.tsx
git commit -m "feat(ui): DetailPageShell with shadcn Tabs"
```

---

## Task 9: `<DashboardShell>` shared component

**Files:**
- Create: `app/(app)/_components/DashboardShell.tsx`

- [ ] **Step 1: Implement**

```tsx
// app/(app)/_components/DashboardShell.tsx

type Props = {
  greeting: React.ReactNode;
  primary: React.ReactNode;        // largest zone (Due soon)
  secondary?: React.ReactNode[];   // 2-up cards (Quick actions, Seasonal checklist)
  tertiary?: React.ReactNode;      // narrow column (Recent activity)
};

export function DashboardShell({ greeting, primary, secondary, tertiary }: Props) {
  return (
    <div className="mx-auto max-w-7xl space-y-6">
      {greeting}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {primary}
          {secondary && (
            <div className="grid gap-4 sm:grid-cols-2">
              {secondary.map((card, i) => (
                <div key={i}>{card}</div>
              ))}
            </div>
          )}
        </div>
        {tertiary && <aside>{tertiary}</aside>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add app/\(app\)/_components/DashboardShell.tsx
git commit -m "feat(ui): DashboardShell three-zone layout"
```

---

## Task 10: `<FormPageShell>` + `applyActionFieldErrors` helper

**Files:**
- Create: `app/(app)/_components/FormPageShell.tsx`
- Create: `lib/forms/helpers.ts`

- [ ] **Step 1: Implement FormPageShell**

```tsx
// app/(app)/_components/FormPageShell.tsx

type Props = {
  header: React.ReactNode;
  maxWidth?: 'lg' | 'xl' | '2xl' | '3xl';
  children: React.ReactNode;
};

const MAX_WIDTH_CLASS: Record<NonNullable<Props['maxWidth']>, string> = {
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  '2xl': 'max-w-2xl',
  '3xl': 'max-w-3xl',
};

export function FormPageShell({ header, maxWidth = '2xl', children }: Props) {
  return (
    <div className={`mx-auto ${MAX_WIDTH_CLASS[maxWidth]}`}>
      {header}
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Implement applyActionFieldErrors helper**

Create `lib/forms/helpers.ts`:

```ts
import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';

import type { ActionResult } from '@/lib/result';

/**
 * Map an ActionResult's fieldErrors into RHF's setError, so server-side
 * validation errors appear under the same FormMessage components as
 * client-side Zod errors.
 *
 * Returns true if errors were applied (caller can use this to decide whether
 * to show a generic toast or skip it).
 */
export function applyActionFieldErrors<T extends FieldValues>(
  setError: UseFormSetError<T>,
  result: Extract<ActionResult<unknown>, { ok: false }>,
): boolean {
  if (!result.fieldErrors) return false;
  let applied = false;
  for (const [field, messages] of Object.entries(result.fieldErrors)) {
    if (messages && messages.length > 0) {
      setError(field as Path<T>, { type: 'server', message: messages[0] });
      applied = true;
    }
  }
  return applied;
}
```

- [ ] **Step 3: Typecheck**

```bash
pnpm typecheck
```

- [ ] **Step 4: Commit**

```bash
git add app/\(app\)/_components/FormPageShell.tsx lib/forms/helpers.ts
git commit -m "feat(ui): FormPageShell + applyActionFieldErrors helper"
```

---

## Task 11: Migrate `/dashboard`

**Files:**
- Modify: `app/(app)/dashboard/page.tsx`
- Possibly modify/create: components in `app/(app)/dashboard/` for `DueSoonLane`, `QuickActionsCard`, `SeasonalChecklistCard` (placeholder), `RecentActivityList`

This is the page that motivated the redesign. Migrate it first to validate `<DashboardShell>` against real data.

- [ ] **Step 1: Read the existing page**

```bash
cat app/\(app\)/dashboard/page.tsx
```

Note: it currently renders `<h1>`, an "Overview" stat card section, an "Upcoming reminders" lane, a "Quick actions" lane, and a "Recent activity" lane — all in inline-styled flexbox. The dashboard queries (`quickStats`, `upcomingReminders`, `recentActivity`) stay; only the JSX changes.

- [ ] **Step 2: Extract sub-components**

Split the existing inline JSX into separate Server Components colocated in `app/(app)/dashboard/`:

- `DashboardGreeting.tsx` — "Hello, {name}" heading.
- `DueSoonLane.tsx` — combines the stat strip (formerly the giant zeros) with the upcoming-reminders list. Renders shadcn `<Card>` containers; stat strip is a row of compact `<div className="flex flex-col">` with `text-2xl font-semibold` numbers (much tighter than the current `font-size: 2rem` cards).
- `QuickActionsCard.tsx` — the "+ Add item / vendor / note" buttons in a single `<Card>` with shadcn `<Button asChild variant="outline">` per link.
- `RecentActivityList.tsx` — the existing relative-time list, restyled with `<Card>` + tighter spacing.
- `SeasonalChecklistCard.tsx` — placeholder `<Card>` with text "Seasonal checklist coming in Plan 4b" for now. Plan 4b's task 20 replaces this with the real component.

- [ ] **Step 3: Compose into DashboardShell**

Rewrite `app/(app)/dashboard/page.tsx`:

```tsx
import { DashboardShell } from '@/app/(app)/_components/DashboardShell';
import { auth } from '@/lib/auth';
import { quickStats, recentActivity, upcomingReminders } from '@/lib/dashboard/queries';
import { DashboardGreeting } from './DashboardGreeting';
import { DueSoonLane } from './DueSoonLane';
import { QuickActionsCard } from './QuickActionsCard';
import { RecentActivityList } from './RecentActivityList';
import { SeasonalChecklistCard } from './SeasonalChecklistCard';

export default async function Dashboard() {
  const [session, stats, activity, reminders] = await Promise.all([
    auth(),
    quickStats(),
    recentActivity(10),
    upcomingReminders(5),
  ]);

  return (
    <DashboardShell
      greeting={<DashboardGreeting name={session?.user?.name ?? 'there'} />}
      primary={<DueSoonLane stats={stats} reminders={reminders} />}
      secondary={[<QuickActionsCard key="qa" />, <SeasonalChecklistCard key="sc" />]}
      tertiary={<RecentActivityList activity={activity} />}
    />
  );
}
```

- [ ] **Step 4: Add `loading.tsx` skeleton**

Create `app/(app)/dashboard/loading.tsx`:

```tsx
import { Skeleton } from '@/components/ui/skeleton';

export default function DashboardLoading() {
  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <Skeleton className="h-8 w-48" />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Skeleton className="h-48" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
          </div>
        </div>
        <Skeleton className="h-64" />
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Visual verification**

```bash
pnpm dev
```

Open `http://localhost:3000/dashboard`. Verify:
- Heading is sans-serif (was already verified in Task 2 but re-confirm).
- Three-zone layout renders: greeting at top, due-soon card prominent, quick actions + seasonal placeholder side-by-side, recent activity in narrow right column.
- Stats are in a compact row with smaller numbers, NOT the giant zeros from the original.
- Empty data: if your dev DB has no items/vendors/reminders, each card shows its own empty state (the `EmptyState` component still renders inline within each card; Task 22 restyles `EmptyState` itself).
- Light + dark themes both look right.

Compare visually against the screenshot that motivated this redesign — the dashboard should feel meaningfully tighter and chrome-supported.

- [ ] **Step 6: E2E**

```bash
pnpm test:e2e tests/e2e/dashboard.spec.ts 2>&1 | tail -10
```

If no dashboard spec exists, skip. If it does and breaks on inline-style assertions, fix the spec to use role/text queries instead.

- [ ] **Step 7: Commit**

```bash
git add app/\(app\)/dashboard
git commit -m "refactor(ui): migrate /dashboard to DashboardShell + shadcn cards"
```

---

## Task 12: Migrate `/items` list

**Files:**
- Modify: `app/(app)/items/page.tsx`
- Modify: `components/items/ItemCardGrid.tsx` (replace inline styles with shadcn `<Card>`)

- [ ] **Step 1: Read existing files**

```bash
cat app/\(app\)/items/page.tsx
cat components/items/ItemCardGrid.tsx
```

Note: `ItemCardGrid` is the chosen view (per spec Q5; `ItemTable` will be deleted in Task 22 cleanup).

- [ ] **Step 2: Rewrite `ItemCardGrid` to use shadcn `<Card>`**

Each item becomes a `<Card>` with:
- `<CardHeader>` containing `<CardTitle>` (the item name as a `<Link>`) and a category `<Badge>`.
- `<CardContent>` containing the location, manufacturer, model snippet (existing data, restyled).
- `<CardFooter>` (optional) with the warranty/service/note counts as muted text.

Replace the existing `<div style={{ display: 'grid', ... }}>` with `<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">`. The breakpoints are subjective; tune in dogfooding.

- [ ] **Step 3: Rewrite `app/(app)/items/page.tsx` to use ListPageShell**

```tsx
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { ListPageShell } from '@/app/(app)/_components/ListPageShell';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/EmptyState';
import { ItemCardGrid } from '@/components/items/ItemCardGrid';
import { listItems } from '@/lib/items/queries';

export default async function ItemsPage() {
  const items = await listItems();
  return (
    <ListPageShell
      header={
        <PageHeader
          title="Items"
          description="Appliances, tools, and other house items."
          actions={
            <Button asChild>
              <Link href="/items/new"><Plus className="h-4 w-4 mr-1" />New item</Link>
            </Button>
          }
        />
      }
      isEmpty={items.length === 0}
      empty={<EmptyState title="No items yet" description="Add your first appliance, tool, or fixture." />}
    >
      <ItemCardGrid items={items} />
    </ListPageShell>
  );
}
```

- [ ] **Step 4: Add `loading.tsx`**

```tsx
// app/(app)/items/loading.tsx
import { Skeleton } from '@/components/ui/skeleton';
export default function ItemsLoading() {
  return (
    <div className="mx-auto max-w-7xl">
      <Skeleton className="mb-6 h-10 w-48" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-40" />)}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Visual verify + E2E**

`pnpm dev` → `/items`. Empty state if no items; card grid otherwise. Both themes.

```bash
pnpm test:e2e tests/e2e/items.spec.ts 2>&1 | tail -10
```

- [ ] **Step 6: Commit**

```bash
git add app/\(app\)/items components/items/ItemCardGrid.tsx
git commit -m "refactor(ui): migrate /items to ListPageShell + shadcn Card"
```

---

## Task 13: Migrate `/items/[id]` detail

**Files:**
- Modify: `app/(app)/items/[id]/page.tsx`
- Migrate sub-components in `components/items/` and any tab-content components

This validates `<DetailPageShell>` against the most complex page in the app (6 tabs).

- [ ] **Step 1: Read existing files**

```bash
cat app/\(app\)/items/\[id\]/page.tsx
ls components/items/
```

Identify which sub-components render which tab content. There may already be tab-like sectioning in the existing inline-styled page.

- [ ] **Step 2: Refactor each tab's content into its own component (if not already)**

Goal: each tab's content is one server component (or client where needed) that the `DetailPageShell` composes via the `tabs` prop.

Recommended file structure:
```
app/(app)/items/[id]/
  page.tsx                   ← uses DetailPageShell
  ItemMetaCard.tsx           ← right-column summary card
  tabs/
    OverviewTab.tsx
    WarrantiesTab.tsx
    ServiceTab.tsx
    RemindersTab.tsx
    NotesTab.tsx
    FilesTab.tsx
```

Move existing JSX from the page into these per-tab files, restyled with shadcn primitives (mostly `<Card>`, `<Table>` for service records, `<Button>` for actions).

- [ ] **Step 3: Rewrite the page**

```tsx
import { notFound } from 'next/navigation';
import { DetailPageShell } from '@/app/(app)/_components/DetailPageShell';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { ItemOverflowMenu } from '@/components/items/ItemOverflowMenu';   // create or restyle from existing
import { getItem } from '@/lib/items/queries';
import { ItemMetaCard } from './ItemMetaCard';
import { OverviewTab } from './tabs/OverviewTab';
import { WarrantiesTab } from './tabs/WarrantiesTab';
import { ServiceTab } from './tabs/ServiceTab';
import { RemindersTab } from './tabs/RemindersTab';
import { NotesTab } from './tabs/NotesTab';
import { FilesTab } from './tabs/FilesTab';

export default async function ItemDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const item = await getItem(id);
  if (!item) notFound();

  return (
    <DetailPageShell
      header={<PageHeader title={item.name} actions={<ItemOverflowMenu item={item} />} />}
      meta={<ItemMetaCard item={item} />}
      tabs={[
        { value: 'overview', label: 'Overview', content: <OverviewTab item={item} /> },
        { value: 'warranties', label: 'Warranties', content: <WarrantiesTab item={item} /> },
        { value: 'service', label: 'Service', content: <ServiceTab item={item} /> },
        { value: 'reminders', label: 'Reminders', content: <RemindersTab item={item} /> },
        { value: 'notes', label: 'Notes', content: <NotesTab item={item} /> },
        { value: 'files', label: 'Files', content: <FilesTab item={item} /> },
      ]}
    />
  );
}
```

- [ ] **Step 4: ItemOverflowMenu (kebab dropdown)**

Plan 4b will add the `includeInSuggestions` toggle to this menu. For now, the menu has whatever existing actions the item-detail page exposed (e.g., Archive, Edit, Delete). Implemented with shadcn `<DropdownMenu>`:

```tsx
'use client';
import { MoreVertical } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function ItemOverflowMenu({ item }: { item: { id: string } }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Item actions">
          <MoreVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild><Link href={`/items/${item.id}/edit`}>Edit</Link></DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* Archive + Delete actions — port existing Server Action calls */}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

- [ ] **Step 5: Add `loading.tsx`**

```tsx
// app/(app)/items/[id]/loading.tsx
import { Skeleton } from '@/components/ui/skeleton';
export default function ItemDetailLoading() {
  return (
    <div className="mx-auto max-w-7xl">
      <Skeleton className="mb-6 h-10 w-64" />
      <div className="grid gap-6 md:grid-cols-3">
        <div className="md:col-span-2">
          <Skeleton className="mb-3 h-9" />
          <Skeleton className="h-96" />
        </div>
        <Skeleton className="h-64" />
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Visual verify**

`pnpm dev` → an item detail page. Verify all 6 tabs render, switching works, meta card appears on the right at desktop and stacks above on mobile. Both themes.

- [ ] **Step 7: E2E**

```bash
pnpm test:e2e tests/e2e/items.spec.ts 2>&1 | tail -10
```

- [ ] **Step 8: Commit**

```bash
git add app/\(app\)/items/\[id\] components/items/ItemOverflowMenu.tsx
git commit -m "refactor(ui): migrate /items/[id] to DetailPageShell with 6 tabs"
```

---

## Task 14: Migrate `/items/new` (form pattern validation gate)

**Files:**
- Modify: `app/(app)/items/new/page.tsx`
- Modify or create: `components/items/ItemForm.tsx`

This is the **pattern-validation gate** for FormPageShell + shadcn `<Form>` integration with the existing RHF + Zod setup. Get this right; Task 15 (`/items/[id]/edit`) is mechanical after.

- [ ] **Step 1: Read existing form**

```bash
cat app/\(app\)/items/new/page.tsx
ls components/forms/ components/items/
```

Identify the existing form composition. Likely it's RHF directly with hand-written `<input>` / `<select>` JSX wrapped in inline-styled labels.

- [ ] **Step 2: Build `<ItemForm>` with shadcn `<Form>`**

This is the canonical pattern; copy the shape for every other form in subsequent tasks.

```tsx
// components/items/ItemForm.tsx
'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { createItem } from '@/lib/items/actions';
import { applyActionFieldErrors } from '@/lib/forms/helpers';
import { createItemSchema } from '@/lib/items/schema';
import type { Category } from '@prisma/client';
import type { z } from 'zod';

type FormValues = z.infer<typeof createItemSchema>;

export function ItemForm({ categories }: { categories: Category[] }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const form = useForm<FormValues>({
    resolver: zodResolver(createItemSchema),
    defaultValues: {
      name: '',
      categorySlug: categories[0]?.slug ?? '',
      location: '',
      manufacturer: '',
      model: '',
      serialNumber: '',
    },
  });

  async function onSubmit(values: FormValues) {
    setSubmitting(true);
    const result = await createItem(values);
    setSubmitting(false);
    if (!result.ok) {
      const applied = applyActionFieldErrors(form.setError, result);
      if (!applied) toast.error(result.formError ?? 'Failed to create item');
      return;
    }
    toast.success('Item created');
    router.push(`/items/${result.data.id}`);
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl><Input {...field} /></FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="categorySlug"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Category</FormLabel>
              <Select onValueChange={field.onChange} defaultValue={field.value}>
                <FormControl>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                </FormControl>
                <SelectContent>
                  {categories.map((c) => (
                    <SelectItem key={c.slug} value={c.slug}>
                      {c.icon ? `${c.icon} ` : ''}{c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
        {/* location, manufacturer, model, serialNumber — same FormField pattern */}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => router.back()}>Cancel</Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Saving…' : 'Create item'}
          </Button>
        </div>
      </form>
    </Form>
  );
}
```

- [ ] **Step 3: Rewrite the page**

```tsx
// app/(app)/items/new/page.tsx
import { FormPageShell } from '@/app/(app)/_components/FormPageShell';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { ItemForm } from '@/components/items/ItemForm';
import { listCategories } from '@/lib/categories';

export default async function NewItemPage() {
  const categories = await listCategories();
  return (
    <FormPageShell header={<PageHeader title="New item" />}>
      <ItemForm categories={categories} />
    </FormPageShell>
  );
}
```

- [ ] **Step 4: Visual verify**

`pnpm dev` → `/items/new`. Verify:
- Form renders with shadcn-styled inputs
- Validation: leave name blank, click Create → field-level red message under the name input ("String must contain at least 1 character" or similar)
- Server-side validation: enter a name like " " (whitespace) that passes client-side but fails server-side — verify `applyActionFieldErrors` shows the error under the right field
- Successful submission redirects to `/items/[id]`
- Toast appears on success ("Item created")

The successful submission validates the entire pipeline: shadcn `<Form>` → RHF → Zod client-validation → Server Action → `ActionResult` → `applyActionFieldErrors` → `FormMessage` → toast.

- [ ] **Step 5: E2E**

```bash
pnpm test:e2e tests/e2e/items.spec.ts 2>&1 | tail -20
```

The create-item E2E test should pass; if it relies on inline-style assertions, update its selectors.

- [ ] **Step 6: Commit**

```bash
git add app/\(app\)/items/new components/items/ItemForm.tsx
git commit -m "refactor(ui): migrate /items/new to shadcn Form (pattern-validation gate)"
```

---

## Task 15: Migrate `/items/[id]/edit` (mechanical follow-up)

**Files:**
- Modify: `app/(app)/items/[id]/edit/page.tsx`
- Likely reuses `<ItemForm>` from Task 14 with an `initialValues` prop

- [ ] **Step 1: Extend `<ItemForm>` to accept initial values**

In `components/items/ItemForm.tsx`, add an optional `initialValues` prop. If provided, use it as `defaultValues`; the submit handler dispatches `updateItem` instead of `createItem`. Either pass a discriminator prop (`mode: 'create' | 'edit'`) or two separate components — discriminator is fine for a 2-mode form.

- [ ] **Step 2: Rewrite the edit page**

```tsx
import { notFound } from 'next/navigation';
import { FormPageShell } from '@/app/(app)/_components/FormPageShell';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { ItemForm } from '@/components/items/ItemForm';
import { listCategories } from '@/lib/categories';
import { getItem } from '@/lib/items/queries';

export default async function EditItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [item, categories] = await Promise.all([getItem(id), listCategories()]);
  if (!item) notFound();
  return (
    <FormPageShell header={<PageHeader title={`Edit ${item.name}`} />}>
      <ItemForm mode="edit" initialValues={item} categories={categories} />
    </FormPageShell>
  );
}
```

- [ ] **Step 3: Verify + commit**

```bash
pnpm dev  # navigate to /items/[id]/edit, verify update flow
git add app/\(app\)/items/\[id\]/edit components/items/ItemForm.tsx
git commit -m "refactor(ui): migrate /items/[id]/edit to FormPageShell"
```

---

## Task 16: Migrate `/settings`

**Files:**
- Modify: `app/(app)/settings/page.tsx`
- Modify: settings sub-components (HouseProfile editor, notification prefs, theme, etc.)

The settings page has multiple form sections; each is a small `<Form>` inside its own `<Card>`.

- [ ] **Step 1: Read existing settings**

```bash
ls app/\(app\)/settings/
cat app/\(app\)/settings/page.tsx
```

Identify each section. Likely sections: HouseProfile, notification preferences, push subscriptions list, account info.

- [ ] **Step 2: Rewrite each section as a `<Card>` with its own form**

Each section's form follows the shadcn `<Form>` pattern from Task 14. Multiple sections live on the same page; each is a separate `<Card>` for visual separation.

```tsx
// app/(app)/settings/page.tsx
import { FormPageShell } from '@/app/(app)/_components/FormPageShell';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { HouseProfileSection } from './HouseProfileSection';
import { NotificationPrefsSection } from './NotificationPrefsSection';
import { PushSubscriptionsSection } from './PushSubscriptionsSection';

export default async function SettingsPage() {
  return (
    <FormPageShell header={<PageHeader title="Settings" />} maxWidth="3xl">
      <div className="space-y-6">
        <HouseProfileSection />
        <NotificationPrefsSection />
        <PushSubscriptionsSection />
      </div>
    </FormPageShell>
  );
}
```

Each section is its own `'use client'` component using shadcn `<Form>`, identical pattern to `<ItemForm>`.

- [ ] **Step 3: Verify + commit**

```bash
pnpm dev  # navigate to /settings, verify each section saves and validation works
git add app/\(app\)/settings
git commit -m "refactor(ui): migrate /settings to FormPageShell with per-section Cards"
```

---

## Task 17: Migrate `/vendors` + `/vendors/[id]`

**Files:**
- Modify: `app/(app)/vendors/page.tsx`
- Modify: `app/(app)/vendors/[id]/page.tsx`
- Modify or create: `app/(app)/vendors/new/page.tsx`, edit page
- Migrate `components/vendors/*` files

Vendors mirror items structurally. List uses a compact table per spec Q5 (kind, phone, tags). Detail uses `<DetailPageShell>` with tabs (Overview, Service, Notes).

- [ ] **Step 1: Migrate `/vendors` list**

Use `<ListPageShell>` + shadcn `<Table>` for the rows. Each row links to `/vendors/[id]`.

```tsx
// vendors-list snippet
<Table>
  <TableHeader>
    <TableRow>
      <TableHead>Name</TableHead>
      <TableHead>Kind</TableHead>
      <TableHead>Phone</TableHead>
      <TableHead>Tags</TableHead>
    </TableRow>
  </TableHeader>
  <TableBody>
    {vendors.map((v) => (
      <TableRow key={v.id}>
        <TableCell><Link href={`/vendors/${v.id}`} className="font-medium">{v.name}</Link></TableCell>
        <TableCell><Badge variant="secondary">{v.kind}</Badge></TableCell>
        <TableCell>{v.phone}</TableCell>
        <TableCell className="flex gap-1">{v.tags.map((t) => <Badge key={t}>{t}</Badge>)}</TableCell>
      </TableRow>
    ))}
  </TableBody>
</Table>
```

- [ ] **Step 2: Migrate `/vendors/[id]` detail**

Mirror Task 13's pattern with fewer tabs. Tabs: Overview, Service Records, Notes.

- [ ] **Step 3: Migrate vendor forms (`new`, `edit`)**

Mirror Task 14's `<ItemForm>` pattern. Likely a `<VendorForm>` component reused across new/edit.

- [ ] **Step 4: loading.tsx for each route**

Mirror Tasks 12 + 13's skeleton patterns.

- [ ] **Step 5: Visual verify + E2E**

```bash
pnpm dev  # /vendors, /vendors/[id], /vendors/new
pnpm test:e2e tests/e2e/vendors.spec.ts 2>&1 | tail -10
```

- [ ] **Step 6: Commit**

```bash
git add app/\(app\)/vendors components/vendors
git commit -m "refactor(ui): migrate /vendors and /vendors/[id] to shells"
```

---

## Task 18: Migrate `/reminders`

**Files:**
- Modify: `app/(app)/reminders/page.tsx`
- Migrate `components/reminders/*` files

Reminders is a list view with completion checkboxes. Use `<ListPageShell>` with an inline list (not a card grid, not a table — a vertical list of reminder rows with `<Checkbox>` for completion).

- [ ] **Step 1: Migrate the list**

Each reminder is a row: `<Checkbox>` + title + due date + (overflow menu for snooze/edit/delete). Use shadcn `<Checkbox>` controlled by the existing complete-reminder action.

- [ ] **Step 2: Migrate add-reminder form** (if present on the same page or `/reminders/new`)

Mirror Task 14's pattern.

- [ ] **Step 3: Verify + commit**

```bash
pnpm dev
pnpm test:e2e tests/e2e/reminders.spec.ts 2>&1 | tail -10
git add app/\(app\)/reminders components/reminders
git commit -m "refactor(ui): migrate /reminders to ListPageShell with Checkbox rows"
```

---

## Task 19: Migrate `/notes`

**Files:**
- Modify: `app/(app)/notes/page.tsx`
- Migrate `components/notes/*` files

Notes is a card grid (markdown-heavy content; cards with truncated body previews work better than a table).

- [ ] **Step 1: Migrate the list**

Mirror Task 12's `<ItemCardGrid>` pattern. Each note is a `<Card>` with title, truncated body (line-clamp-3), tags, updated-at relative time.

- [ ] **Step 2: Migrate the editor**

If there's a `/notes/new` and `/notes/[id]/edit`, mirror Task 14's pattern. Note bodies use shadcn `<Textarea>` (markdown is plain-text input).

- [ ] **Step 3: Verify + commit**

```bash
pnpm dev
pnpm test:e2e tests/e2e/notes.spec.ts 2>&1 | tail -10
git add app/\(app\)/notes components/notes
git commit -m "refactor(ui): migrate /notes to ListPageShell + shadcn Card grid"
```

---

## Task 20: Migrate `/search`

**Files:**
- Modify: `app/(app)/search/page.tsx`
- Migrate `components/search/SearchResults.tsx` (or whichever file renders results)

Search results need to remain visually distinct from list pages — they're cross-kind hits with kind-icon prefixes. Use `<ListPageShell>` with a custom result row component.

- [ ] **Step 1: Migrate results rendering**

Each result row: kind icon (lucide), title (link to `result.href`), body snippet, kind badge. The existing `<SearchResults>` component (Plan 4a) gets restyled.

- [ ] **Step 2: Migrate facet filters**

If facet UI exists (kind filters), use shadcn `<Badge variant="outline">` with click handlers as the toggle UI. Or shadcn `<ToggleGroup>` if the design calls for it.

- [ ] **Step 3: Verify + commit**

```bash
pnpm dev
pnpm test:e2e tests/e2e/search.spec.ts 2>&1 | tail -10
git add app/\(app\)/search components/search
git commit -m "refactor(ui): migrate /search to ListPageShell with restyled result rows"
```

---

## Task 21: Migrate `/service` + `/warranties`

**Files:**
- Modify: `app/(app)/service/page.tsx`
- Modify: `app/(app)/warranties/page.tsx`
- Migrate `components/service-records/*`, `components/warranties/*`

Both are tabular list pages. Service records use shadcn `<Table>` with sortable columns (cost, performed-on date). Warranties use a similar table with provider, coverage period, end-date countdown.

- [ ] **Step 1: Migrate `/service`**

```tsx
<Table>
  <TableHeader>
    <TableRow>
      <TableHead>Performed</TableHead>
      <TableHead>Item</TableHead>
      <TableHead>Vendor</TableHead>
      <TableHead>Summary</TableHead>
      <TableHead className="text-right">Cost</TableHead>
    </TableRow>
  </TableHeader>
  <TableBody>{/* rows */}</TableBody>
</Table>
```

- [ ] **Step 2: Migrate `/warranties`**

Similar table shape. Highlight rows nearing expiration with a `<Badge variant="destructive">`.

- [ ] **Step 3: Verify + commit**

```bash
pnpm dev
pnpm test:e2e tests/e2e/service-records.spec.ts tests/e2e/warranties.spec.ts 2>&1 | tail -10
git add app/\(app\)/service app/\(app\)/warranties components/service-records components/warranties
git commit -m "refactor(ui): migrate /service and /warranties to ListPageShell + shadcn Table"
```

---

## Task 22: Cleanup

**Files:**
- Modify: `app/globals.css` (delete legacy utility classes)
- Modify: `components/EmptyState.tsx` (restyle to use shadcn)
- Delete: `components/items/ItemTable.tsx`
- Modify: any remaining inline-styled files surfaced by `grep`

- [ ] **Step 1: Delete `ItemTable.tsx`**

```bash
rm components/items/ItemTable.tsx
grep -rn "ItemTable" app/ components/ lib/
# Expected: no results. If anything imports it, fix the importer.
```

(Per spec: card grid is the v1 view for items; if a table view is wanted later, it's net-new work using shadcn `<Table>`, not a revert of this deletion.)

- [ ] **Step 2: Delete legacy utility classes from `globals.css`**

Remove these blocks (they're around lines 86-110 of the post-Task-2 globals.css):

```css
.badge { ... }
.badge-sm { ... }
.table-row { ... }
.table-header { ... }
.table-cell { ... }
```

Then `grep -rn "badge\|badge-sm\|table-row\|table-header\|table-cell" app/ components/` — expect mostly empty (the class names are common English; filter for `className="...badge..."` patterns specifically). If anything still uses them, replace with shadcn `<Badge>` or shadcn `<Table>` cells.

- [ ] **Step 3: Restyle `EmptyState`**

```tsx
// components/EmptyState.tsx
import { cn } from '@/lib/utils';

type Props = {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
};

export function EmptyState({ icon, title, description, action, className }: Props) {
  return (
    <div className={cn('flex flex-col items-center justify-center rounded-md border border-dashed p-12 text-center', className)}>
      {icon && <div className="mb-3 text-muted-foreground">{icon}</div>}
      <h2 className="text-lg font-semibold">{title}</h2>
      {description && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
```

- [ ] **Step 4: Hunt for remaining inline styles**

```bash
grep -rln "style=" app/ components/ | wc -l
```

The pre-plan count was ~56. After all migrations the count should be near zero (some may legitimately remain — e.g., dynamic `style={{ width: progress + '%' }}` for progress bars). Open each remaining file and assess: if the inline style can be a Tailwind class, replace; if it's truly dynamic, leave with a one-line comment explaining why.

- [ ] **Step 5: Run Biome**

```bash
pnpm lint:fix
```

- [ ] **Step 6: Commit**

```bash
git add app/globals.css components/EmptyState.tsx components
git rm components/items/ItemTable.tsx
git commit -m "chore(ui): delete ItemTable, legacy utility classes, restyle EmptyState"
```

---

## Task 23: Plan 4b amendment + final verify

**Files:**
- Modify: `docs/superpowers/plans/2026-05-01-plan-4b-suggest.md`
- (No code changes; final verification of the whole branch)

The Plan 4b plan was written against the inline-styled UI. After 4ab merges, when 4b resumes, it needs to use shadcn primitives. This task records the amendment in the plan doc itself.

- [ ] **Step 1: Read Plan 4b's plan document**

```bash
cat docs/superpowers/plans/2026-05-01-plan-4b-suggest.md | wc -l
# Expected: ~3900 lines
```

Identify the UI tasks (16, 17, 18, 21, 23, 24, 25). These are the tasks that referenced inline-styled JSX or `btn-primary` className strings.

- [ ] **Step 2: Add an "Amendment after Plan 4ab" section**

Append to the end of `docs/superpowers/plans/2026-05-01-plan-4b-suggest.md`:

```markdown
## Amendment after Plan 4ab (UI redesign)

After Plan 4ab merged, this plan rebases onto post-4ab main. The schema commit (Task 1, `00e95a7`) is conflict-free. UI tasks below now use shadcn primitives instead of inline-styled placeholders.

**Task 16 (`/checklists` index)** — replace raw `<main>` shell with `<ListPageShell>`. Replace inline-styled `<Link href="/checklists/new">New checklist</Link>` with `<Button asChild><Link>...</Link></Button>`. Cards use shadcn `<Card>`.

**Task 17 (`/checklists/[id]` editor)** — replace raw form composition with shadcn `<Form>` + `<FormField>`. Use `<FormPageShell>` (or a custom shell — checklist editor has add-item inline UX that may benefit from a wider container; designer's call).

**Task 18 (SuggestionPreview)** — replace placeholder `btn-primary` className strings with `<Button variant="default">`. Replace placeholder `btn-ghost` with `<Button variant="ghost">`. The dashboard entry point's `<Dialog>` uses shadcn's `<Dialog>` primitive (this is unchanged behavior — Plan 4b's spec already specified a dialog).

**Task 21 (post-create interstitial)** — `<main className="mx-auto max-w-xl p-6">` becomes a `<FormPageShell>` (treats the interstitial as a small form-like page). Buttons become shadcn.

**Task 23 (`/suggest` standalone)** — `<textarea>` becomes shadcn `<Textarea>`. Submit button shadcn `<Button>`. Wrap the entire page in `<FormPageShell>`.

**Task 24 (per-item toggle)** — wire the `IncludeInSuggestionsToggle` component into `<ItemOverflowMenu>` (which now exists from Plan 4ab Task 13). Use shadcn `<DropdownMenuCheckboxItem>` rather than a raw `<input type="checkbox">`.

**Task 25 (admin /admin/ai)** — stat strip uses shadcn `<Card>`. Page uses `<FormPageShell>` or `<ListPageShell>` (designer's call — admin is read-only stats so ListPageShell with no list is fine).

Server Action contracts and tests don't change. The amendment is mechanical — same logic, different JSX nouns.
```

- [ ] **Step 3: Run full verify on plan-4ab-ui-redesign branch**

```bash
pnpm verify
# Expected: lint ✓ typecheck ✓ test:unit ✓
```

- [ ] **Step 4: Run integration**

```bash
pnpm test:integration
# Expected: every existing test green. The redesign should not have broken
# any non-UI test.
```

- [ ] **Step 5: Run E2E**

```bash
pnpm test:e2e
# Expected: every existing spec green (or the few that needed selector
# updates have been updated in the relevant migration tasks).
```

- [ ] **Step 6: Manual eyeball every route**

```bash
pnpm dev
```

Visit each route in light mode, then dark:
- `/dashboard`
- `/items` + `/items/new` + `/items/[id]` + `/items/[id]/edit`
- `/vendors` + `/vendors/[id]` + `/vendors/new`
- `/reminders`
- `/notes`
- `/search` (with a query)
- `/service`
- `/warranties`
- `/settings`

For each: verify the sidebar is present and active state lights correctly, the page content is shadcn-styled (no inline-style sprawl visible), forms validate correctly, theme toggle flips properly.

- [ ] **Step 7: Drop the spike stash**

```bash
git stash list  # confirm spike-tailwind-v4-discard is still there
git stash drop  # if you trust the redesign is complete; or keep it 24h
```

- [ ] **Step 8: Commit**

```bash
git add docs/superpowers/plans/2026-05-01-plan-4b-suggest.md
git commit -m "docs(plan-4b): amendment for shadcn primitives after 4ab"
```

- [ ] **Step 9: Hand off to finishing-a-development-branch**

Use the `superpowers:finishing-a-development-branch` skill to merge / open PR / coordinate with `plan-4b-suggest` rebase.

---

## Reference: skills to invoke during implementation

- `@superpowers:test-driven-development` — applicable to the four shells (Tasks 6-10) which are pure presentation components and benefit from snapshot tests; the migration tasks (11-21) are inherently visual and rely on E2E + manual eyeball.
- `@superpowers:systematic-debugging` — when something doesn't work, don't guess. Especially relevant to Task 2's post-init cleanup — the @theme + light-dark() interaction has surprising edges.
- `@superpowers:verification-before-completion` — the visual-verification step is mandatory; never claim a migration task done without `pnpm dev` + eyeball.
- `@superpowers:requesting-code-review` — at end of major groups: after Task 5 (foundation + chrome complete), after Task 16 (forms pattern proven), after Task 22 (cleanup done).
- `@superpowers:finishing-a-development-branch` — Task 23's handoff.

---

## Open implementation questions (resolve at start of Task 2)

1. Confirm shadcn-cli ≥ 4.6.0 is installed and the `base-nova` preset is the default. If a major has shipped that changes the preset story, read its release notes.
2. Confirm `@base-ui/react` is acceptable as the underlying primitive library. If you want Radix instead, run `pnpm dlx shadcn@latest init --base radix` rather than the `-d` defaults invocation.
3. Confirm PR #23 status and decide rebase order.
