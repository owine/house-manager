# Plan 4ab — UI redesign: design system, navigation, page templates

**Date:** 2026-05-02
**Status:** Draft for review
**Authors:** Oliver Wine (with Claude)
**Parent spec:** `docs/superpowers/specs/2026-04-26-house-manager-design.md`
**Builds on:** Plans 1, 2a-2c, 3, 4a — all shipped to main as of 2026-05-02.

## Overview

Plan 4ab is a focused **app-wide UI redesign** inserted into the roadmap between Plan 4a (shipped) and Plan 4b (paused mid-execution at Task 1). It does not add features. It replaces the current ad-hoc inline-styled UI with a coherent design system built on **Tailwind v4 + shadcn/ui**, adds a **persistent left sidebar navigation chrome**, and migrates every existing route onto four shared **page-template shells**.

The trigger was visual inspection of `/dashboard` showing serif-by-default headings (root cause: no `font-family` set on `body`, browser fell back to default serif), no navigation off the dashboard (the only paths were the empty-state CTAs), thin-bordered skeletal stat cards, and a vast empty layout. The systemic cause is that styling lives in `style={{ ... }}` inline objects across every component file, with no design vocabulary — no spacing scale, no typography scale, no component primitives. Every styling decision was hand-tuned per file, which guarantees inconsistency.

The redesign **keeps** the existing theme-token system (`app/globals.css` defines tokens via the modern `light-dark()` CSS function — well-designed and worth preserving) and **layers** Tailwind v4 + shadcn on top of it via `@theme` mapping, so there is one source of truth for color values and two consumers (legacy `var(--bg)` references and shadcn's `bg-background`-style class names).

## Goals

1. Eliminate the serif-by-default heading bug and every other "this looks like a wireframe" symptom across the app.
2. Provide a vocabulary — Tailwind utilities + 16 shadcn primitives + 4 page-template shells — that future plans build on instead of inventing per-page.
3. Add real navigation chrome (left sidebar) so users can reach every primary section without typing URLs.
4. Replace inline `style={{ ... }}` sprawl with utility classes + composed shadcn components. Delete the legacy `.badge`/`.table-*` utility classes that filled the gap before.
5. Keep the existing `light-dark()` theme tokens; expose them as Tailwind theme values via `@theme`. Light/dark toggle continues working without modification.
6. Slot before Plan 4b (currently paused after schema migration) so 4b's 5+ new UI surfaces are born into the new system rather than getting redone in Plan 5.

## Non-goals

- **No new features.** No behavior changes. Visual + structural only.
- **No new dependencies beyond Tailwind v4, shadcn-cli, Radix primitives (transitive), and `lucide-react`.** No DataTable, no Calendar, no Toast variants beyond Sonner.
- **No custom color palette / brand identity.** shadcn's neutral defaults; brand work is a Plan 5 concern.
- **No custom font import.** System sans stack (`ui-sans-serif, system-ui, ...`) is enough — fixes the serif bug; custom fonts are a Plan 5 concern if desired.
- **No animation framework.** Tailwind transitions only; no Framer Motion, no View Transitions API.
- **No PWA chrome refresh** (manifest icons, splash screens, install prompt design) — defer to Plan 5.
- **No comprehensive a11y audit** — shadcn primitives ship with Radix's a11y baseline, which is good; full audit is a Plan 5 concern.
- **No DataTable migration of `/service` or other tables to TanStack Table.** Plain `<Table>` is enough at this scale.
- **Plan 4b's checklists pages** (`/checklists`, `/checklists/[id]`) are NEW pages built into the new system as part of Plan 4b's scope, not migrated by Plan 4ab.

## Architecture

### Foundation: Tailwind v4 + theme tokens

Tailwind v4 is CSS-first — no `tailwind.config.js`. Theme is declared via the `@theme` directive in `app/globals.css`. The existing `light-dark()` token block stays as the source of truth; `@theme` maps shadcn's expected variable names onto those tokens:

```css
/* app/globals.css (after redesign) */
@import "tailwindcss";

:root {
  color-scheme: light dark;
  --bg: light-dark(#ffffff, #0e0e10);
  --bg-elevated: light-dark(#f7f7f7, #1a1a1d);
  --fg: light-dark(#111111, #f0f0f0);
  --fg-muted: light-dark(#666666, #9a9a9a);
  --border: light-dark(#dddddd, #2a2a2d);
  --accent: light-dark(#0066cc, #4d9fff);
  --accent-fg: light-dark(#ffffff, #0e0e10);
  --danger: light-dark(#b00020, #ff6b6b);
  /* ... existing tokens unchanged ... */
}

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
  --color-primary: var(--accent);
  --color-primary-foreground: var(--accent-fg);
  --color-secondary: var(--bg-elevated);
  --color-secondary-foreground: var(--fg);
  --color-accent: var(--bg-elevated);     /* hover fills, sidebar active row, etc. */
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

body {
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-sans);
}
```

The existing `[data-theme="light"]` and `[data-theme="dark"]` overrides continue working without modification — they only change `color-scheme`, and `light-dark()` resolves correctly under all three states (system, manual light, manual dark). The existing `<ThemeToggle>` component keeps its API.

### shadcn install set (20 primitives)

Each is copied via `pnpm dlx shadcn@latest add <name>` into `components/ui/<name>.tsx`. They become files in this repo — no upstream upgrade pressure.

| Primitive | Used for |
|---|---|
| `Button` | Every action button |
| `Card` | Dashboard stat cards, list cards, detail panels |
| `Input` | All text inputs |
| `Textarea` | Markdown bodies, descriptions |
| `Label` | Every form field label |
| `Form` | RHF + Zod wrapper; replaces existing custom form composition |
| `Select` | Category pickers, kind selectors |
| `Checkbox` | Reminder completion, suggestion-preview rows |
| `Switch` | Settings toggles |
| `Dialog` | Suggestion preview modals, confirmation prompts |
| `DropdownMenu` | Item-detail overflow menu, sidebar user menu |
| `Tabs` | Item-detail tabs (Overview / Warranties / etc.) |
| `Table` | Service records, sortable lists |
| `Badge` | Category chips, tags, status; replaces `.badge`/`.badge-sm` |
| `Sidebar` | Left rail nav |
| `Sheet` | Used by `Sidebar` for mobile collapse (explicit install — shadcn-cli does not reliably auto-pull transitive component deps) |
| `Separator` | Visual rules between sidebar nav groups; in-page dividers |
| `Tooltip` | Required by `Sidebar`'s `collapsible="icon"` mode for the collapsed-rail labels |
| `Avatar` | Sidebar footer user identity (initials-only acceptable; no image source today) |
| `Sonner` | Toast notifications (action errors, save confirmations) |

The plan's Task 2 verifies after each `add` command that `components/ui/<name>.tsx` actually landed and that its imports compile. shadcn-cli sometimes silently no-ops on transitive deps; the install set is explicit so we don't discover missing primitives at runtime.

### Icons

`lucide-react` (the icon library shadcn defaults to). Tree-shaken; only imported icons ship in the bundle. Replaces the emoji glyphs the codebase currently uses for nav and search-result icons. Emoji *category* icons in the data layer (`Category.icon` in Prisma) stay — they're user-facing content, not chrome.

### Navigation chrome

`AppSidebar` in `app/(app)/_components/AppSidebar.tsx`, mounted in `app/(app)/layout.tsx`. Built on shadcn `<Sidebar>` (auto-handles desktop collapse + mobile sheet).

```
┌──────────────────┬──────────────────────────────────────────────────┐
│ House Manager    │ <header>                                          │
│ ─────────────    │   <SidebarTrigger />  <SearchBar />               │
│ ⌂ Dashboard      │ </header>                                         │
│ 📦 Items         │ ─────────────────────────────────────────────────│
│ 🏢 Vendors       │                                                   │
│ ⏰ Reminders     │   <main>                                          │
│ ✅ Checklists    │     {children}                                    │
│ 📝 Notes         │   </main>                                         │
│ 🔍 Search        │                                                   │
│ ─────────────    │                                                   │
│ ⚙ Settings       │                                                   │
│ 🛡 Admin*        │  *only when session.user.role === 'ADMIN'         │
│ ─────────────    │                                                   │
│ 🌙 Theme toggle  │                                                   │
│ owine ▾          │                                                   │
└──────────────────┴──────────────────────────────────────────────────┘
```

**Active state**: shadcn's `<SidebarMenuButton isActive>` derived from `usePathname()`. `/items`, `/items/[id]`, `/items/new`, and `/items/[id]/edit` all light up "Items".

**Collapse**: shadcn's `collapsible="icon"` mode for desktop; mobile auto-collapses to a sheet behind the hamburger trigger.

**Header chrome inside the main column**:
- Left: `<SidebarTrigger />` (hamburger on mobile, collapse arrow on desktop).
- Middle: `<SearchBar />` (existing component, restyled to use shadcn `<Input>`).
- Right: removed. The "Signed in as owine" indicator moves to the sidebar footer's user dropdown.

### Page templates (4 shells)

In `app/(app)/_components/`. Every existing page composes one of these instead of hand-rolling layout.

#### `<PageHeader>`

Used by all four shells. Single source of truth for page titles, descriptions, and primary action buttons. Same vertical rhythm everywhere.

```tsx
<PageHeader
  title="Items"
  description="Appliances, tools, and other house items."  // optional
  actions={<Button asChild><Link href="/items/new">+ New item</Link></Button>}  // optional
/>
```

#### `<ListPageShell>`

For `/items`, `/vendors`, `/notes`, `/reminders`, `/search`, `/service`, `/warranties`, plus the future `/checklists` (Plan 4b).

```tsx
<ListPageShell
  header={<PageHeader title="Items" actions={...} />}
  filters={<ItemsFilterBar />}        // optional
  empty={<EmptyState ... />}           // shown when children render no items
>
  {/* Card grid, table, or list — caller's choice per the per-list-designer-choice rule */}
</ListPageShell>
```

Provides: header slot, optional filter bar, max-width container, empty-state slot. Existing `EmptyState.tsx` keeps its API; restyled internally.

Per-list view choice:
- `/items` — card grid (richer per-item info; deletes `ItemTable.tsx`)
- `/vendors` — compact `<Table>` (kind, phone, tags)
- `/notes` — card grid
- `/reminders` — list with completion-checkbox affordance
- `/search` — existing search-results component, restyled
- `/service` — sortable `<Table>` (cost column matters)
- `/warranties` — list

#### `<DetailPageShell>`

For `/items/[id]`, `/vendors/[id]`. Two-column layout matching the master spec's "Item detail page is the centerpiece — tabbed: Overview · Warranties · Service · Reminders · Notes · Files."

```tsx
<DetailPageShell
  header={<PageHeader title={item.name} actions={<ItemOverflowMenu />} />}
  meta={<ItemMetaCard item={item} />}    // sidebar-style summary card
  tabs={[
    { value: 'overview', label: 'Overview', content: <Overview /> },
    { value: 'warranties', label: 'Warranties', content: <Warranties /> },
    { value: 'service', label: 'Service', content: <Service /> },
    { value: 'reminders', label: 'Reminders', content: <Reminders /> },
    { value: 'notes', label: 'Notes', content: <Notes /> },
    { value: 'files', label: 'Files', content: <Files /> },
  ]}
/>
```

Renders main column (tabs) at desktop ~2/3 width, meta card at ~1/3. Meta stacks above tabs on mobile.

#### `<DashboardShell>`

```tsx
<DashboardShell
  greeting={<DashboardGreeting />}
  primary={<DueSoonLane />}                                       // largest zone
  secondary={[<QuickActionsCard />, <SeasonalChecklistCard />]}   // 2-up
  tertiary={<RecentActivityList />}                               // narrow column
/>
```

Three zones matching the master spec's "Due soon / Active checklists / Recent activity" layout. The current dashboard's "Overview" stat-card row gets folded into `<DueSoonLane>` as a compact stat strip rather than a 4-card row of giant zeroes (which is what made the screenshot feel empty). `SeasonalChecklistCard` is the dashboard entry point Plan 4b will populate.

#### `<FormPageShell>`

For `/items/new`, `/items/[id]/edit`, `/settings`, `/checklists/new`.

```tsx
<FormPageShell
  header={<PageHeader title="New item" />}
  maxWidth="2xl"  // ~672px; forms read better in a single narrow column
>
  <ItemForm />
</FormPageShell>
```

All forms move to shadcn `<Form>` + `<FormField>` + `<FormControl>` + `<FormMessage>`. Replaces the existing custom form composition in `components/forms/`.

### State patterns

#### Loading

- **Server Components**: per-route `loading.tsx` rendering shadcn `<Skeleton>` shapes that mirror the page template (a `ListPageShell` skeleton shows header skeleton + 6 card skeletons; `DetailPageShell` skeleton shows header + tabs outline + meta card outline).
- **Client-side actions**: button switches to disabled with a `<Loader2 className="animate-spin">` glyph + retained label. Replaces inline "Saving…" text strings.

#### Empty

Single `<EmptyState>` component (existing file path, restyled internally). shadcn doesn't ship one; we extend the existing.

```tsx
<EmptyState
  icon={<Package className="h-10 w-10" />}
  title="No items yet"
  description="Add your first appliance, tool, or fixture."
  action={<Button asChild><Link href="/items/new">Add item</Link></Button>}
/>
```

Used on every empty list, the dashboard's empty zones, and Plan 4b's Suggest empty-proposals UI.

#### Error

- **Page-level errors** (Server Component throws): existing `app/error.tsx` and `app/global-error.tsx` get restyled; shape unchanged — title, message, retry button.
- **Action-level errors**: toast via Sonner. Add `<Toaster />` in the root app layout.
- **Form field errors**: shadcn `<Form>`'s `<FormMessage />` reads from RHF error state. The existing `ActionResult.fieldErrors` shape gets mapped into RHF's `setError` on response. A small helper `applyActionFieldErrors(form, result)` lives in `lib/forms/helpers.ts` (new file).

## Migration plan

The plan document (writing-plans skill output) sequences the work as tasks. The shape:

1. **Foundation** — install Tailwind v4 + shadcn-cli, configure `components.json`, write the `app/globals.css` `@theme` block, set the body `font-family`. End state: `pnpm build` succeeds; dashboard renders with sans-serif headings (visible improvement; verifies the layer works).
2. **Install primitives** — copy in the 20 shadcn primitives (one shadcn-cli `add` per primitive; no per-component code yet). Verify after each that `components/ui/<name>.tsx` was created and that `pnpm typecheck` is clean.
3. **Sidebar + AppLayout chrome** — `AppSidebar`, restructured `AppLayout`. End state: every existing page renders inside the new chrome (page bodies still inline-styled at this checkpoint). Sidebar nav functional. Mobile collapse working.
4. **Page templates** — `<PageHeader>`, `<ListPageShell>`, `<DetailPageShell>`, `<DashboardShell>`, `<FormPageShell>`. Includes a temporary `app/(app)/_dev/templates` route to eyeball each shell against placeholder content; route deleted at the end of the plan.
5. **Migrate routes**, in order of visibility/risk:
   1. `/dashboard` — the page that motivated the redesign
   2. `/items` list
   3. `/items/[id]` detail (validates `<DetailPageShell>` against the most complex page)
   4. `/items/new` (validates `<FormPageShell>` + shadcn `<Form>` against existing RHF integration — pattern-validation gate)
   5. `/items/[id]/edit` (mechanical follow-up after `/items/new` proves the form pattern works)
   6. `/settings` (smaller form page; second consumer of the form pattern)
   7. `/vendors` + `/vendors/[id]`
   8. `/reminders`
   9. `/notes`
   10. `/search`
   11. `/service` + `/warranties`
6. **Cleanup** — delete legacy `.badge`, `.badge-sm`, `.table-row`, `.table-header`, `.table-cell` utility classes from `globals.css`; delete `ItemTable.tsx` (per Q5: card grid is the v1 view for items; if a table view is wanted later, it'd be net-new work using shadcn `<Table>`, not a revert of this deletion); remove inline-style sprawl; run Biome.
7. **Verify** — `pnpm verify` green; manual eyeball of every route in light + dark; existing Playwright E2E suite green (most should survive — the suite uses semantic role/text queries which shadcn primitives respect).

## Plan 4b amendment

After Plan 4ab merges, `plan-4b-suggest` rebases onto post-4ab main. Schema commit (`00e95a7`) is conflict-free. The plan document (`docs/superpowers/plans/2026-05-01-plan-4b-suggest.md`) gets a single revision pass:

- Tasks 16, 17 (Checklist UI): swap raw HTML for `<ListPageShell>`, shadcn `<Button>`, shadcn `<Card>`.
- Task 18 (SuggestionPreview): replace placeholder `btn-primary` strings with shadcn `<Button variant="default">`. (The dashboard entry point's `<Dialog>` is **not new behavior** — Plan 4b's spec already specifies "Button 'Generate {season} checklist' → opens dialog with `<SuggestionPreview kind='checklist'>`" in its Application surface section. The amendment swaps a raw modal-ish element for shadcn `<Dialog>`; lifecycle and trigger are unchanged.)
- Tasks 21, 23, 24, 25: swap raw HTML for shadcn equivalents.

Server Action contracts and tests don't change. The amendment is mechanical.

## Roadmap

```
Plan 1   — Foundation (SHIPPED)
Plan 2a  — Core CRUD (SHIPPED)
Plan 2b  — Attachments (SHIPPED)
Plan 2c  — Attachment links (SHIPPED)
Plan 3   — Reminders, push, email, iCal (SHIPPED)
Plan 4a  — Find: Meilisearch keyword search (SHIPPED)
Plan 4ab — UI redesign: design system, navigation, page templates (THIS PLAN)
Plan 4b  — Suggest: AI structured generation (PAUSED at Task 1; resumes after 4ab)
Plan 4c  — Ask: RAG over user documents + OCR
Plan 5   — Polish & operations (a11y audit, brand identity, custom fonts, PWA chrome,
            DataTable migration, animation polish, etc.)
```

`docs/README.md`'s "Plans status" section gets updated to reflect this ordering as part of Plan 4ab's first task.

## Cost & risk

- **No runtime cost.** No new services, no new API calls, no bundle-size step-changes (Tailwind v4 produces small CSS; shadcn primitives are tree-shaken; lucide icons are tree-shaken).
- **Build-time cost.** Tailwind v4's CSS engine is fast — order-of-magnitude faster than v3 — so `next build` time should drop, not rise.
- **Migration risk.** The Playwright E2E suite is the safety net. Most assertions use accessible role queries (`getByRole`, `getByText`) which survive the migration. Any tests that target inline-style attributes or specific `className` values will need updates; the plan calls those out as part of each route's task.
- **Visual-regression coverage.** The repo doesn't have visual-regression tests. Manual eyeball of every route in light + dark is the verification step. Adding visual-regression infra is out of scope (Plan 5).
- **Rollback.** Single feature branch (`plan-4ab-ui-redesign`); revert is one `git revert <merge-commit>` if anything goes wrong post-merge. The schema is untouched, so no data implications.

## Pre-plan compatibility spike

Before the writing-plans skill produces the plan document, a one-hour verification spike confirms the toolchain triple works end-to-end:

1. In a throwaway branch off main, run `pnpm dlx shadcn@latest init` against the current Next.js 16 + Tailwind v4 setup.
2. Run `pnpm dlx shadcn@latest add button card sidebar` (one of each install-set category — utility, surface, complex).
3. Drop a `<Button>` and `<Sidebar>` into a temporary route. Run `pnpm build` and `pnpm dev`.
4. Verify the shadcn primitives render with theme tokens correctly resolving (light + dark), that `pnpm typecheck` is clean, and that `components.json` was generated with the Tailwind v4 indicator (`tailwind.cssVariables: true`, no `tailwind.config` path) — shadcn-cli has had v4-detection regressions in past versions; checking `components.json` directly is more reliable than inferring from build success.

If this spike fails, the spec needs revision before planning — likely respec'ing onto Tailwind v3 (the `@theme` block becomes a `tailwind.config.ts` theme.extend, and several spec sections change). Hitting the fallback is **not** "a few hours of config files"; it's a respec. The spike happens before any planning to avoid that.

## Open questions

- **Mobile breakpoints**. shadcn `<Sidebar>` defaults to the `md:` breakpoint for collapse. v1 keeps that default; if dogfooding shows it's wrong (e.g., on 1024×768 tablets it's awkward), Plan 5 tunes it.
- **Custom theme tokens for hover/active states**. The spec maps `--color-accent` to `var(--bg-elevated)` so that hover fills work with the existing tokens. If shadcn's hover affordance reads as too subtle on this token (it's a single elevation step from the base bg), v1 ships as-is and we adjust the token assignment in Plan 5 if needed. No new tokens — just one variable assignment.
