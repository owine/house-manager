# Remove the prod `-migrate` container — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the prod compose's one-shot `house-manager-migrate` service by folding `pnpm db:deploy && pnpm db:seed` into `web`'s startup command. Worker waits on `web: service_healthy` instead. After this lands, the prod compose structurally matches the in-repo `docker-compose.yml`.

**Architecture:** Two-line YAML change on the deploy host (`web.command` + `worker.depends_on`), plus an optional dev/prod parity tweak in the in-repo compose (`start_period: 30s → 120s`), plus a runbook in the PR description so the operator can apply the prod edit safely. No code changes; the image already ships everything needed (Dockerfile:86-94 copies `prisma/`, `prisma.config.ts`, schema, migrations, and the `tsx` runner; production `node_modules` from line 80 includes the Prisma CLI).

**Tech Stack:** docker compose, Prisma 7, Postgres 18 (pgvector pg18 image). See [project_overview](memory:project_overview).

**Spec:** `docs/superpowers/specs/2026-05-24-remove-migrate-container-design.md`

---

## Scope note

The deploy-host edit is the load-bearing change, but it can't be made through the repo PR — it lives on the operator's host. The implementer's deliverable is:
- Documentation accuracy in the repo (README, backups.md spot-check).
- The optional in-repo `start_period` parity bump.
- A clear runbook in the PR description so the operator can apply the prod compose edit in 2-3 minutes without surprises.

The actual prod compose edit is a separate operator action ([feedback_op_run_secrets](memory:feedback_op_run_secrets) — give `${VAR}`-placeholder commands, don't source `compose.env` over SSH).

---

## File Map

**Modify (in repo):**
- `docker-compose.yml` — bump `web.healthcheck.start_period` from `30s` to `120s` (line 76). Single-line dev/prod parity tweak.
- `docs/README.md` — verify there is NO mention of the `-migrate` container. If a deploy section exists, update it to describe the new shape.

**Verify only (no changes expected):**
- `docs/backups.md` — spot-check for `-migrate` references; the spec believes there are none.
- `Dockerfile` lines 80, 86-94 — confirm the image already supports running `prisma migrate deploy` + `prisma db seed` (the spec asserts this; verify before writing the runbook).

**Create:**
- Nothing new in the repo. The PR description gets the operator runbook (inline, not a separate file — operator-facing runbooks aren't standard in this repo).

---

## Task 1: Verify image readiness + audit doc references

**Files:**
- Read only: `Dockerfile`, `docs/README.md`, `docs/backups.md`, in-repo `docker-compose.yml`

This is a pre-flight pass. No commits. The point is to confirm the spec's assumptions before changing anything, and to gather any doc snippets that need updating in Task 2.

- [ ] **Step 1: Confirm the image ships everything migrate/seed needs**

Read `Dockerfile` lines 70-100. Confirm:
- `prisma/` is COPY'd (includes `schema.prisma` and `migrations/`).
- `prisma.config.ts` is COPY'd.
- `node_modules` is COPY'd from the build stage AFTER `pnpm prune --prod` (or equivalent) — so the Prisma CLI is present at runtime.
- `tsx` is present in production `node_modules` (the seed runs via `tsx ./prisma/seed.ts` per `prisma.config.ts`).

If anything's missing, STOP and surface it — the spec's "no image change required" claim would be wrong and the prod cutover would fail at runtime.

- [ ] **Step 2: Audit `docs/README.md` for `-migrate` references**

```bash
grep -n "migrate" docs/README.md
```

Expected: only mentions of `pnpm db:migrate` (a CLI command) and `db:deploy` — NOT a container. The spec believes there are no container references. Confirm.

If you find a `-migrate` container mention, capture the lines that need updating; you'll edit them in Task 2.

- [ ] **Step 3: Spot-check `docs/backups.md`**

```bash
grep -n "migrate" docs/backups.md
```

Expected: no matches. If there are, capture them.

- [ ] **Step 4: Confirm in-repo `docker-compose.yml` matches the target shape**

Read `docker-compose.yml` lines 57-91. Confirm:
- Line 70: `command: sh -c "pnpm db:deploy && pnpm db:seed && pnpm start"`.
- Worker `depends_on` only has `db: service_healthy`; no `migrate` dep.
- `web.healthcheck.start_period: 30s` at line 76 (this is what Task 2 will bump).

If any of these don't match, the spec's "already in target shape" assumption is wrong — STOP and report.

- [ ] **Step 5: No commit; report findings to the controller**

This task ends with a status report, not a commit. The findings drive Task 2's edits.

---

## Task 2: Bump local `start_period` for dev/prod parity

**Files:**
- Modify: `docker-compose.yml` (line 76)

The local compose currently has `start_period: 30s`. The spec calls for the prod compose to use `120s` so a future longer migration set doesn't trip the healthcheck. Match locally so the two files stay in sync on this field — one fewer source of dev/prod drift.

- [ ] **Step 1: Edit the start_period**

In `docker-compose.yml`, change:

```yaml
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:3000/api/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 30s
```

to:

```yaml
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:3000/api/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 120s
```

- [ ] **Step 2: Smoke-test the local compose**

```bash
docker compose down
docker compose up -d
docker compose ps
```

Expected: `web` shows `healthy` within ~30s on a clean DB (migrations + seed are quick). The longer `start_period` is just headroom for future migrations; nothing observable should change on the current migration set.

- [ ] **Step 3: Bring it back down**

```bash
docker compose down
```

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml
git commit -m "chore(compose): bump web healthcheck start_period to 120s for dev/prod parity"
```

---

## Task 3: Update docs (if needed)

**Files:**
- Modify: `docs/README.md` (only if Task 1 found a `-migrate` container reference)
- Modify: `docs/backups.md` (only if Task 1 found a reference)

This task is **conditional** — it only runs if Task 1 turned up doc references to the `-migrate` container. The spec believes there are none. If Task 1 confirmed clean, skip directly to Task 4.

- [ ] **Step 1: Update README**

For each line Task 1 flagged, rewrite to describe the new shape: web runs `pnpm db:deploy && pnpm db:seed && pnpm start` at startup; worker waits on `web: service_healthy`; no separate migrate container.

- [ ] **Step 2: Update backups.md**

Same shape of edit.

- [ ] **Step 3: Commit**

```bash
git add docs/README.md docs/backups.md
git commit -m "docs: describe inline migrate+seed shape (no -migrate container)"
```

If neither file needed changes, no commit; just skip this task.

---

## Task 4: Draft the operator runbook for the PR description

**Files:**
- No file edits; the runbook lives in the PR body.

The runbook is the load-bearing artifact for this PR — it's how the operator actually applies the prod change. Keep it tight, with copy-pasteable commands.

- [ ] **Step 1: Draft the runbook**

Compose this Markdown (the exact text goes into `gh pr create --body`):

```markdown
## Operator runbook — prod cutover

On the deploy host, edit the prod compose file (e.g. `/opt/compose/compose.yml`):

1. Delete the `house-manager-migrate` service block entirely.
2. Update the `web` service:
   - `command: sh -c "pnpm db:deploy && pnpm db:seed && pnpm start"`
   - In `depends_on`, remove the `<migrate>: { condition: service_completed_successfully }` line; keep `db: { condition: service_healthy }`.
   - In `healthcheck`, raise `start_period` to `120s` (note its current value first so you can roll back if needed).
3. Update the `worker` service:
   - In `depends_on`, remove `<migrate>: { condition: service_completed_successfully }`.
   - Add `web: { condition: service_healthy }` alongside the existing `db: { condition: service_healthy }`.

Then apply:

```sh
docker compose down
docker compose pull
docker compose up -d
docker compose logs -f web
```

Watch web logs for:
- `prisma migrate deploy` output (no pending migrations on a routine deploy — they ship with the image).
- Seed output (idempotent; safe to re-run on every restart).
- `ready - started server on …`.

Once web shows `healthy` in `docker compose ps`, worker starts automatically. Then:

```sh
docker compose logs -f worker
curl -fsS http://<deploy-host>:3000/api/health
```

### Rollback

If web crashloops on migration failure:

```sh
docker compose logs web --no-color | tail -200   # capture the failure
docker compose down
# Re-add the `house-manager-migrate` service block from the pre-change compose,
# and revert the `web.command` + `web.depends_on` + `worker.depends_on` edits.
docker compose up -d
```

The image is unchanged — rolling back is purely a YAML revert, no `docker pull` needed.
```

- [ ] **Step 2: Stash it where Task 5 will pick it up**

Save the runbook text in a scratch file or directly in the PR-create command in Task 5. No commit.

---

## Task 5: Open the PR

**Files:**
- No file edits.

- [ ] **Step 1: Confirm branch + commits**

```bash
git status
git log --oneline origin/main..HEAD
```

Expected: 1 commit (`chore(compose): bump web healthcheck start_period to 120s for dev/prod parity`), optionally 2 if Task 3 fired (`docs: describe inline migrate+seed shape …`). Spec + plan commits already live on `main` from the brainstorm phase — they're not part of this PR.

If you're still on `main`, create a feature branch first:

```bash
git checkout -b chore/remove-migrate-container
```

(If Task 2 was committed directly on `main` by mistake, move the commits to a branch and reset main: `git branch chore/remove-migrate-container && git reset --hard origin/main && git checkout chore/remove-migrate-container`.)

- [ ] **Step 2: Push the branch**

```bash
git push -u origin HEAD
```

- [ ] **Step 3: Open the PR with the runbook in the body**

```bash
gh pr create --title "chore: remove prod -migrate container (fold into web startup)" --body "$(cat <<'EOF'
## Summary
- Collapses the prod compose's one-shot `house-manager-migrate` service by folding `pnpm db:deploy && pnpm db:seed` into `web`'s startup command — matches the in-repo `docker-compose.yml` shape.
- Worker `depends_on` re-targets from `<migrate>: service_completed_successfully` → `web: service_healthy`. Web's healthcheck (`/api/health`) only goes green after `pnpm start` is serving, so migrations + seeding are guaranteed done by the time worker boots.
- Local `web.healthcheck.start_period` bumped from `30s` to `120s` for parity with the prod `start_period` value the runbook installs.

Spec: `docs/superpowers/specs/2026-05-24-remove-migrate-container-design.md`
Plan: `docs/superpowers/plans/2026-05-24-remove-migrate-container.md`

## Operator runbook — prod cutover

<PASTE THE RUNBOOK FROM TASK 4 STEP 1 HERE — preserve fenced code blocks>

## Test plan
- [x] `docker compose down && docker compose up -d && docker compose ps` — local web reaches `healthy`
- [ ] Operator: apply prod runbook above, confirm web + worker healthy, `/api/health` returns 200
- [ ] Operator: trigger a routine restart (`docker compose restart web`) and confirm seed is idempotent (no duplicate rows, no errors)
EOF
)"
```

- [ ] **Step 4: Report back the PR URL**

---

## Risks / non-goals

- **Image readiness assumption.** Task 1 verifies it; if any of the COPY'd paths in Dockerfile have moved since the spec was written, surface it in the Task 1 report.
- **Optional in-repo bump only.** This PR doesn't *force* the prod change — that's the operator's call. The runbook is the prompt; the YAML lives outside the repo.
- **Seed idempotency.** Already a property of the dev compose (seed runs every restart there). If a future seed edit ever stops being idempotent, this design breaks — flag in the seed file's review.
