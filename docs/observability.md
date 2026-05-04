# Observability

The app emits structured logs to stdout (Pino) and reports exceptions to a configured Sentry-compatible endpoint (`@sentry/nextjs`). Both are optional — the app works fine with neither configured.

## Environment variables

All optional. Set in `.env`, `docker-compose.yml`, or your host's environment.

| Var | Purpose | Default |
|---|---|---|
| `LOG_LEVEL` | Pino level (`fatal`, `error`, `warn`, `info`, `debug`, `trace`). | `info` in prod, `debug` in dev |
| `SENTRY_DSN` | Server-side Sentry/GlitchTip endpoint. Sentry init no-ops when unset. | unset |
| `NEXT_PUBLIC_SENTRY_DSN` | Browser-side DSN (must be the `NEXT_PUBLIC_` form because Next.js inlines it into the client bundle at build time). Set to the same value as `SENTRY_DSN` to get both server and browser coverage. | unset |
| `SENTRY_AUTH_TOKEN` | Source-map upload token. Sentry skips upload when unset. **Build-time only** — passed to `docker build` as a buildkit secret (`--secret id=sentry_auth_token,src=...`), NOT as a build-arg, so it never lands in image history. | unset |

## Reading logs in dev

`pnpm dev` emits raw JSON. For human-readable colors:

```bash
pnpm dev | pnpm exec pino-pretty
```

(Don't bake this into `pnpm dev` itself — it breaks `pnpm dev | grep ...` patterns and adds a process to manage.)

## Reading logs in prod

```bash
docker logs <container>           # all logs
docker logs <container> --since 1h # recent logs
docker logs <container> | jq .    # parse JSON
```

For querying / retention / dashboards, ship `docker logs` to Loki via Promtail. That's homelab work, separate from this app.

## Setting up GlitchTip

1. Run GlitchTip in your homelab Docker Compose. The image is `glitchtip/glitchtip` plus a Postgres sidecar.
2. Create a project; copy the DSN.
3. Set `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN` to the same DSN value.
4. (Optional) Create an internal integration in GlitchTip and copy the auth token. To enable source-map upload during `pnpm build`, write the token to a file and pass it as a buildkit secret:
   ```bash
   echo "$YOUR_TOKEN" > /tmp/sentry-token
   docker build --secret id=sentry_auth_token,src=/tmp/sentry-token ...
   ```
   The Dockerfile mounts the secret only for the build RUN; the token never lands in any image layer or history.
5. Restart the app. Errors now flow to GlitchTip with grouping and alerting.

## Naming conventions

Each module gets a child logger with a dot-separated module name mirroring its file location (dropping the `lib/` prefix):

| File | Logger module |
|---|---|
| `lib/ai/suggest/reminders.ts` | `ai.suggest.reminders` |
| `lib/ai/suggest/checklist.ts` | `ai.suggest.checklist` |
| `lib/queue.ts` | `queue` |
| `lib/search/client.ts` | `search.client` |
| `lib/attachments/actions.ts` | `attachments.actions` |
| `worker/index.ts` | `worker.lifecycle` |
| `worker/jobs/thumbnail.ts` | `worker.thumbnail` |

This makes Loki/Grafana queries trivial later: `{module=~"ai.suggest.*"}` returns every Suggest event.

## Redaction

The Pino singleton redacts these key paths regardless of nesting depth:

- `*.apiKey`
- `*.token`
- `*.secret`
- `*.password`
- `req.headers.cookie`
- `req.headers.authorization`

Add new paths to `lib/logger.ts` as new sensitive fields appear.
