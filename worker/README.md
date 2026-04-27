# Worker

Background job runner for House Manager. Uses pg-boss as the queue (PostgreSQL-backed; no Redis required).

## Run (dev or prod)

```
pnpm worker:dev    # equivalent to pnpm worker:start
```

The worker is run via `tsx` (TypeScript executed directly), not pre-compiled. No
`worker:build` step exists. This avoids path-alias and ESM-extension issues that
arise when tsc-emitted JS runs under Node.

The worker connects to the same Postgres instance as the web app. In Plan 1 it
registers no jobs — it just verifies the queue can start and exits gracefully on SIGTERM/SIGINT. Real jobs (reminder notifications, document indexing, Meilisearch sync) arrive in subsequent plans.
