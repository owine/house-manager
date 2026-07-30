# Parts PR 3 — Search and Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make *"what bulb goes in the backyard string lights?"* answerable — index parts in Meilisearch and embed them for Ask.

**Architecture:** Parts join the two existing generic pipelines. `'part'` becomes a `SearchKind`, `PART` an `EmbeddingEntityType`, and the `enqueueSearchIndex` / `enqueueEmbed` calls deliberately omitted in PRs 1b and 2 get filled in.

**Tech Stack:** Prisma 7 / Postgres 18 + pgvector, Meilisearch, Voyage embeddings, pg-boss worker, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-29-parts-design.md`

---

## This is the payoff PR, and the smallest of the four

PR 1a built the tables, 1b the UI, 2 the conversational capture. **None of it is retrievable yet.** A part's specification — the thing the whole construct exists to hold — cannot be searched or asked about. The spec's first stated requirement is "Spec lookup: *what bulb goes in the backyard string lights?*", and this PR is the only one that delivers it.

The seams are already cut and commented, which is why this should be small:

```
lib/parts/actions.ts:15   // no enqueueSearchIndex / enqueueEmbed — until PR 3
lib/chat/actions.ts:1121  // same deliberate seam on the part apply path
```

Both comments explain that the helpers are typed to `SearchKind` / `EmbeddingEntityType`, so the calls could not have compiled earlier. Delete the comments when you fill the seams — a stale "until PR 3" note in shipped code is worse than none.

## Read this before starting

- **Search and embeddings are eventually consistent by design.** `enqueueSearchIndex` and `enqueueEmbed` swallow their own errors and log a warning: a failed enqueue must never fail the user's mutation. Recovery is the nightly `search.reindex` and `embed.backfill`. Match that posture exactly — do not add a throwing path.
- **Embeddings are gated on `ASK_ENABLED` at both producer and consumer.** Check how existing kinds handle it; parts must behave identically.
- `pnpm test:unit` / `test:integration` pass directory arguments, so appending a path *widens* the run. Single file: `pnpm exec vitest run <path>`.
- `git commit` can fail **silently** behind the Biome hook, and separately on a 1Password SSH signing error (`failed to fill whole buffer`). After every commit run `git log --oneline -1` and confirm HEAD moved.
- Do not run `prisma migrate reset` — blocked for agentic sessions.

## Task 1: Meilisearch

**Files:** `lib/search/schema.ts`, `lib/search/document.ts`, `lib/parts/actions.ts`, `lib/chat/actions.ts`

- [ ] `'part'` into `SEARCH_KINDS`. Then follow the type errors — `ICON`, `RowFor`, `toDocument`, `buildDocument` and the reindex enumerator in `lib/search/document.ts` are all keyed on the union, so the compiler will name them.
- [ ] **The document text is the point of this PR.** A part's searchable text must include its **spec metadata**, not just its name — `base`, `shape`, `colorTempK`, `merv`, `nominalSize`. Searching "E26" or "20x25x1" is the actual use case. Use `visibleMetadataEntries` from `lib/metadata/reserved-keys.ts` so `_provenance` never reaches the index.
- [ ] Include `manufacturer`, `model` and `sku` — the re-buy identity fields — and the linked parents' names, so "furnace filter" finds it even when the part is named "FPR 10 20x25x1".
- [ ] Fill the enqueue seam in `lib/parts/actions.ts` (create / update / archive / restore) **and** the part apply path in `lib/chat/actions.ts`. Delete both `until PR 3` comments.
- [ ] **Archived parts follow whatever items already do.** Check `buildDocument` and the reindex enumerator rather than inventing a policy — and remember a part is archived *wherever all its parents are*, so use `LIVE_PART` / `ARCHIVED_PART` from `lib/parts/queries.ts` rather than `archivedAt: null`.
- [ ] Tests: `toDocument` for a part includes its spec values and drops reserved keys; the reindex enumerator emits parts.

## Task 2: Embeddings

**Files:** `prisma/schema.prisma` + migration, `lib/embedding/canonicalize.ts`, `lib/embedding/index.ts`, `worker/jobs/embed-*.ts`

- [ ] `PART` into `EmbeddingEntityType`. Generate with `prisma migrate dev --create-only --name embedding_part`, then `migrate deploy` — **never bare `migrate dev`** (needs a TTY, prompts on warnings) and the `--create-only` + `deploy` order means the recorded checksum matches the file you ship.
- [ ] **Check the generated SQL for a dropped IVFFlat index.** Prisma emitted `DROP INDEX "embeddings_embedding_cosine_idx"` unprompted on the last enum migration in this repo (`9b53e5e`) and it had to be removed by hand. This migration touches the same table, so assume it will happen again.
- [ ] `canonicalizePart` alongside the six existing canonicalizers, following their shape. Same content rules as the search document: name, kind, manufacturer/model/sku, **the spec fields**, linked parents, notes. Drop reserved metadata keys — `canonicalizeItem` is the model.
- [ ] The producer select in `lib/embedding/index.ts` must load what `canonicalizePart` reads. PR 1a shipped a canonicalizer fix that was inert because its select wasn't updated; don't repeat it.
- [ ] Fill the `enqueueEmbed` seams, gated on `ASK_ENABLED` exactly as the other kinds are.
- [ ] Tombstone cleanup: `Embedding` has **no FK** to its entity (deliberate — six per-entity tables was the alternative), so `embed-content` handles deletion explicitly. Parts need the same treatment; find where the other kinds do it.
- [ ] Tests: `canonicalizePart` output; an integration test that creating a part enqueues an embed when `ASK_ENABLED` and does not when it isn't.

## Task 3: Verification

- [ ] ```bash
      pnpm verify
      pnpm test:integration
      pnpm exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma
      pnpm lint:knip
      pnpm test:coverage
      ```
      Drift must show **only** the known IVFFlat line. Never lower a coverage threshold.
- [ ] **Prove the payoff end to end.** Seed a part with a real spec, run the indexer, and search for a spec value (`E26`, `20x25x1`) — not just the part's name. A test that only searches the name would pass while the feature that justifies this PR is broken.
- [ ] Keep the diff under **150,000 characters** or Sourcery declines to review it (`docs/**` is already excluded from its path filters).

## What "done" looks like

- Searching `E26` or `20x25x1` finds the part, not just searching its name.
- Ask can answer *"what bulb goes in the backyard string lights?"* from an AI-captured part, with no manual data entry anywhere in the chain.
- No `until PR 3` comment survives anywhere in the tree.
- No reserved metadata key reaches Meilisearch or an embedding.

## Out of scope

Part targets on `CREATE_SERVICE_RECORD` in chat. An Attachments tab for parts (`lib/attachments` `PARENT_TYPES` has no `part`, and `attachments.partId` already exists, so it is a separate small change).
