# Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the runnable skeleton — Next.js web + Node worker + Postgres+pgvector + Meilisearch in Docker Compose — with Authelia OIDC sign-in working, a minimal authenticated dashboard, and the full lint/typecheck/test/CI toolchain wired up. End state: an authenticated user can sign in via Authelia and see "Hello, &lt;name&gt;," and CI is green.

**Architecture:** Monorepo (single package). Next.js 15 App Router + RSC for the web tier; standalone Node entrypoint for the worker; both share `lib/` and a single Prisma client. One Dockerfile builds one image; web and worker run it with different entrypoints. Auth.js v5 owns OIDC; the rest of the app reads `auth()` server-side. Postgres uses the `pgvector/pgvector:pg16` image. Meilisearch runs as a service but is not yet integrated — that's Plan 4.

**Tech Stack:** Next.js 15, TypeScript 5.x (strict), Prisma 6, Postgres 16 + pgvector, Meilisearch 1.10, Auth.js v5 (`next-auth@beta`), pg-boss, pnpm 9, Biome 1.9, Vitest 2, Playwright 1.48, lefthook, Testcontainers, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-04-26-house-manager-design.md`

---

## File structure created by this plan

```
.
├── .env.example                          — every required env var
├── .github/workflows/ci.yml              — lint, typecheck, unit, integration, e2e, build
├── .gitignore
├── .nvmrc                                — Node 22
├── biome.json                            — lint + format config
├── docker-compose.yml                    — db, meilisearch, web, worker
├── Dockerfile                            — multi-stage; produces single image
├── lefthook.yml                          — pre-commit hooks
├── package.json
├── playwright.config.ts
├── pnpm-lock.yaml
├── tsconfig.json                         — strict
├── vitest.config.ts
├── prisma/
│   ├── schema.prisma                     — User + HouseProfile + Account/Session for Auth.js
│   ├── migrations/                       — generated, committed
│   └── seed.ts                           — no-op for now (Categories arrive in Plan 2)
├── public/
│   └── (empty placeholder)
├── scripts/
│   └── setup.sh                          — generate VAPID keys, write .env
├── lib/
│   ├── db.ts                             — Prisma client singleton
│   ├── auth.ts                           — Auth.js v5 config (Authelia OIDC)
│   └── env.ts                            — env var validation via Zod
├── app/
│   ├── layout.tsx                        — root layout
│   ├── page.tsx                          — landing → redirects authenticated users to /dashboard
│   ├── api/
│   │   ├── auth/[...nextauth]/route.ts   — Auth.js handlers
│   │   ├── health/route.ts               — liveness
│   │   └── health/ready/route.ts         — readiness (db + meilisearch)
│   └── (app)/
│       ├── layout.tsx                    — auth-gated layout
│       └── dashboard/page.tsx            — "Hello, <name>"
├── worker/
│   ├── index.ts                          — pg-boss bootstrap, registers no jobs yet
│   └── README.md                         — how to run locally
├── tests/
│   ├── unit/                             — vitest target
│   │   └── env.test.ts                   — env validation
│   ├── integration/                      — vitest, testcontainers
│   │   ├── setup.ts                      — spins up postgres + meilisearch
│   │   └── health.test.ts                — readiness probe hits real db
│   └── e2e/                              — playwright target
│       └── signin.spec.ts                — mocked OIDC happy path
└── docs/
    └── README.md                         — project orientation
```

---

## Task 1: Initialize project with pnpm + Next.js 15 + TypeScript

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml` (single-package), `tsconfig.json`, `.nvmrc`, `.gitignore`, `next.config.ts`, `app/layout.tsx`, `app/page.tsx`

- [ ] **Step 1: Pin Node version**

Create `.nvmrc`:
```
22
```

- [ ] **Step 2: Initialize package.json**

```bash
pnpm init
```

Then edit to set:
```json
{
  "name": "house-manager",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.0.0", "pnpm": ">=9.0.0" },
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 3: Install Next.js 15 + React 19**

```bash
pnpm add next@15 react@19 react-dom@19
pnpm add -D typescript@5 @types/react @types/react-dom @types/node
```

- [ ] **Step 4: Create tsconfig.json (strict)**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 5: Create minimal app/layout.tsx and app/page.tsx**

`app/layout.tsx`:
```tsx
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

`app/page.tsx`:
```tsx
export default function Home() {
  return <main>House Manager</main>;
}
```

- [ ] **Step 6: Create .gitignore**

```
node_modules
.next
.env
.env.local
*.tsbuildinfo
playwright-report
test-results
coverage
/data
```

- [ ] **Step 7: Run typecheck and dev server smoke test**

```bash
pnpm typecheck
pnpm dev
```

Expected: typecheck passes; `curl http://localhost:3000` returns HTML containing "House Manager".

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: scaffold Next.js 15 + TypeScript project"
```

---

## Task 2: Configure Biome (lint + format)

**Files:**
- Create: `biome.json`
- Modify: `package.json` (add scripts)

- [ ] **Step 1: Install Biome**

```bash
pnpm add -D --save-exact @biomejs/biome@1.9
```

- [ ] **Step 2: Create biome.json**

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": { "ignoreUnknown": true },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "javascript": { "formatter": { "quoteStyle": "single", "semicolons": "always", "trailingCommas": "all" } },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "style": { "useImportType": "warn", "useNodejsImportProtocol": "warn" },
      "suspicious": { "noExplicitAny": "warn" },
      "correctness": { "noUnusedImports": "error", "noUnusedVariables": "warn" }
    }
  },
  "organizeImports": { "enabled": true }
}
```

- [ ] **Step 3: Add lint/format scripts**

In `package.json`:
```json
{
  "scripts": {
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "format": "biome format --write ."
  }
}
```

- [ ] **Step 4: Run lint**

```bash
pnpm lint
```

Expected: pass (no source errors yet).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: configure Biome for lint and format"
```

---

## Task 3: Add Vitest (unit tests)

**Files:**
- Create: `vitest.config.ts`, `tests/unit/sanity.test.ts`
- Modify: `package.json`, `tsconfig.json`

- [ ] **Step 1: Install Vitest**

```bash
pnpm add -D vitest@2 @vitest/coverage-v8
```

- [ ] **Step 2: Create vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'lib/**/*.test.ts'],
    globals: false,
    environment: 'node',
  },
  resolve: {
    alias: { '@': new URL('./', import.meta.url).pathname },
  },
});
```

- [ ] **Step 3: Add a sanity test**

`tests/unit/sanity.test.ts`:
```ts
import { describe, expect, it } from 'vitest';

describe('sanity', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 4: Add scripts**

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage"
  }
}
```

- [ ] **Step 5: Run it**

```bash
pnpm test
```

Expected: 1 passing test.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test: add Vitest with sanity test"
```

---

## Task 4: Add env validation with Zod

**Files:**
- Create: `lib/env.ts`, `tests/unit/env.test.ts`

- [ ] **Step 1: Install Zod**

```bash
pnpm add zod
```

- [ ] **Step 2: Write the failing test first (TDD)**

`tests/unit/env.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseEnv } from '@/lib/env';

describe('parseEnv', () => {
  it('parses a valid environment', () => {
    const env = parseEnv({
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      AUTH_SECRET: 'a'.repeat(32),
      AUTH_OIDC_ISSUER: 'https://auth.example.com',
      AUTH_OIDC_CLIENT_ID: 'house-manager',
      AUTH_OIDC_CLIENT_SECRET: 'secret',
      MEILI_HOST: 'http://meilisearch:7700',
      MEILI_KEY: 'key',
      FILES_DIR: '/data/files',
      NODE_ENV: 'test',
    });
    expect(env.DATABASE_URL).toBe('postgresql://u:p@localhost:5432/db');
  });

  it('rejects missing required vars', () => {
    expect(() => parseEnv({})).toThrow();
  });

  it('rejects short AUTH_SECRET', () => {
    expect(() =>
      parseEnv({
        DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
        AUTH_SECRET: 'short',
        AUTH_OIDC_ISSUER: 'https://auth.example.com',
        AUTH_OIDC_CLIENT_ID: 'x',
        AUTH_OIDC_CLIENT_SECRET: 's',
        MEILI_HOST: 'http://m:7700',
        MEILI_KEY: 'k',
        FILES_DIR: '/data/files',
        NODE_ENV: 'test',
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 3: Run the test, verify it fails**

```bash
pnpm test
```

Expected: FAIL — `parseEnv` not exported.

- [ ] **Step 4: Implement lib/env.ts**

```ts
import { z } from 'zod';

const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
  AUTH_OIDC_ISSUER: z.string().url(),
  AUTH_OIDC_CLIENT_ID: z.string().min(1),
  AUTH_OIDC_CLIENT_SECRET: z.string().min(1),
  MEILI_HOST: z.string().url(),
  MEILI_KEY: z.string().min(1),
  FILES_DIR: z.string().min(1),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type Env = z.infer<typeof EnvSchema>;

export function parseEnv(input: Record<string, string | undefined>): Env {
  return EnvSchema.parse(input);
}

export const env: Env = parseEnv(process.env);
```

- [ ] **Step 5: Run the test, verify it passes**

```bash
pnpm test
```

Expected: 4 passing tests (sanity + 3 env).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add Zod-validated env loader"
```

---

## Task 5: Set up Prisma with Postgres + pgvector

**Files:**
- Create: `prisma/schema.prisma`, `lib/db.ts`, `prisma/seed.ts`
- Modify: `package.json`

- [ ] **Step 1: Install Prisma**

```bash
pnpm add @prisma/client
pnpm add -D prisma tsx
```

- [ ] **Step 2: Initialize prisma/schema.prisma**

```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["postgresqlExtensions"]
}

datasource db {
  provider   = "postgresql"
  url        = env("DATABASE_URL")
  extensions = [pgvector(map: "vector")]
}

enum Role {
  ADMIN
  MEMBER
}

model User {
  id            String    @id @default(cuid())
  // Populated post-sign-in by an Auth.js createUser event (see Task 7).
  // Nullable because the Prisma adapter creates the user row before the
  // event fires; unique once set.
  oidcSub       String?   @unique
  email         String    @unique
  // Auth.js adapter writes these; must be present and nullable for it to work.
  emailVerified DateTime?
  name          String?
  image         String?
  role          Role      @default(MEMBER)
  createdAt     DateTime  @default(now())
  lastLoginAt   DateTime  @default(now())

  @@map("users")
}

model HouseProfile {
  id           String   @id @default(cuid())
  location     String?
  climateZone  String?
  propertyType String?
  updatedAt    DateTime @updatedAt

  @@map("house_profile")
}
```

- [ ] **Step 3: Create lib/db.ts (singleton client)**

```ts
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ?? new PrismaClient({ log: ['warn', 'error'] });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
```

- [ ] **Step 4: Create no-op seed**

`prisma/seed.ts`:
```ts
async function main() {
  console.log('Seed: nothing to do in Plan 1.');
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 5: Add scripts**

```json
{
  "scripts": {
    "db:generate": "prisma generate",
    "db:migrate": "prisma migrate dev",
    "db:deploy": "prisma migrate deploy",
    "db:seed": "tsx prisma/seed.ts"
  },
  "prisma": { "seed": "tsx prisma/seed.ts" }
}
```

- [ ] **Step 6: Generate Prisma client**

```bash
pnpm db:generate
```

Expected: client generated to `node_modules/@prisma/client`.

- [ ] **Step 7: Commit (without migration yet — needs a running DB)**

```bash
git add -A
git commit -m "feat: add Prisma schema with User and HouseProfile"
```

---

## Task 6: Docker Compose stack (db + meilisearch only, for dev)

**Files:**
- Create: `docker-compose.yml`, `.env.example`

- [ ] **Step 1: Create .env.example**

```
# Database
DATABASE_URL=postgresql://housemanager:devpassword@localhost:5432/housemanager
POSTGRES_PASSWORD=devpassword
POSTGRES_DB=housemanager
POSTGRES_USER=housemanager

# Auth (Auth.js)
AUTH_SECRET=<generate with `openssl rand -base64 32`>
AUTH_URL=http://localhost:3000
AUTH_OIDC_ISSUER=https://auth.example.com
AUTH_OIDC_CLIENT_ID=house-manager
AUTH_OIDC_CLIENT_SECRET=<from Authelia client config>

# Meilisearch
MEILI_HOST=http://localhost:7700
MEILI_KEY=<generate with `openssl rand -hex 32`>
MEILI_MASTER_KEY=<same as MEILI_KEY>

# Files
FILES_DIR=./data/files

# AI (placeholders; not required until Plan 4)
ANTHROPIC_API_KEY=
VOYAGE_API_KEY=

# Email (placeholder; not required until Plan 3)
FORWARDEMAIL_API_KEY=

# Push (placeholders; not required until Plan 3)
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:admin@example.com

# Runtime
NODE_ENV=development
```

- [ ] **Step 2: Create docker-compose.yml (dev variant — only db + meili)**

```yaml
services:
  db:
    image: pgvector/pgvector:pg16
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    ports: ["5432:5432"]
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 5s
      timeout: 5s
      retries: 10

  meilisearch:
    image: getmeili/meilisearch:v1.10
    restart: unless-stopped
    environment:
      MEILI_MASTER_KEY: ${MEILI_MASTER_KEY}
      MEILI_ENV: development
    ports: ["7700:7700"]
    volumes:
      - meilidata:/meili_data
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:7700/health"]
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  pgdata:
  meilidata:
```

(Web/worker services arrive in Task 13. For dev, you run `pnpm dev` on the host against these.)

- [ ] **Step 3: Bring up services and run first migration**

```bash
cp .env.example .env
# Edit .env: set AUTH_SECRET, MEILI_KEY/MEILI_MASTER_KEY to real generated values
docker compose up -d db meilisearch
sleep 3
pnpm db:migrate -- --name init
```

Expected: a migration is created in `prisma/migrations/<timestamp>_init/` and applied.

- [ ] **Step 4: Verify pgvector is loaded**

```bash
docker compose exec db psql -U housemanager -d housemanager -c "CREATE EXTENSION IF NOT EXISTS vector; SELECT extname FROM pg_extension WHERE extname='vector';"
```

Expected: `vector` row returned.

> Note: Prisma's `extensions` block enables this automatically on `migrate dev` for fresh databases. The manual command is just verification.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add Docker Compose stack for Postgres+pgvector and Meilisearch"
```

---

## Task 7: Auth.js v5 with Authelia OIDC

**Files:**
- Create: `lib/auth.ts`, `app/api/auth/[...nextauth]/route.ts`, `middleware.ts`
- Modify: `prisma/schema.prisma` (add Account/Session for the Prisma adapter)

- [ ] **Step 1: Install Auth.js v5 + Prisma adapter**

```bash
pnpm add next-auth@beta @auth/prisma-adapter
```

- [ ] **Step 2: Add Auth.js tables to schema.prisma**

Append to `prisma/schema.prisma`:

```prisma
model Account {
  id                String  @id @default(cuid())
  userId            String
  type              String
  provider          String
  providerAccountId String
  refresh_token     String? @db.Text
  access_token      String? @db.Text
  expires_at        Int?
  token_type        String?
  scope             String?
  id_token          String? @db.Text
  session_state     String?

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([provider, providerAccountId])
  @@map("accounts")
}

model Session {
  id           String   @id @default(cuid())
  sessionToken String   @unique
  userId       String
  expires      DateTime
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("sessions")
}

model VerificationToken {
  identifier String
  token      String   @unique
  expires    DateTime

  @@unique([identifier, token])
  @@map("verification_tokens")
}
```

Add to `User`:
```prisma
  accounts  Account[]
  sessions  Session[]
```

- [ ] **Step 3: Create migration**

```bash
pnpm db:migrate -- --name auth_tables
```

- [ ] **Step 4: Create lib/auth.ts**

The `oidcSub` column on `User` is populated by a `createUser` event after the
Prisma adapter inserts the row. The `signIn` callback bumps `lastLoginAt` on
subsequent sign-ins.

```ts
import { PrismaAdapter } from '@auth/prisma-adapter';
import NextAuth from 'next-auth';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: { strategy: 'database' },
  secret: env.AUTH_SECRET,
  trustHost: true,
  providers: [
    {
      id: 'authelia',
      name: 'Authelia',
      type: 'oidc',
      issuer: env.AUTH_OIDC_ISSUER,
      clientId: env.AUTH_OIDC_CLIENT_ID,
      clientSecret: env.AUTH_OIDC_CLIENT_SECRET,
      authorization: { params: { scope: 'openid profile email groups' } },
    },
  ],
  events: {
    async createUser({ user }) {
      // The Prisma adapter has just inserted the user row.
      // The OIDC sub is in the Account row created alongside it.
      const account = await prisma.account.findFirst({
        where: { userId: user.id, provider: 'authelia' },
      });
      if (account) {
        await prisma.user.update({
          where: { id: user.id },
          data: { oidcSub: account.providerAccountId },
        });
      }
    },
  },
  callbacks: {
    async signIn({ user, account }) {
      if (account?.provider !== 'authelia') return false;
      // user.id is set on subsequent sign-ins (existing user). On first sign-in,
      // the createUser event handles initial state; lastLoginAt was set by @default.
      if (user.id) {
        await prisma.user.update({
          where: { id: user.id },
          data: { lastLoginAt: new Date() },
        }).catch(() => {
          // Race during first-ever sign-in: user row may not exist yet. Safe to ignore;
          // createUser handles the initial state (lastLoginAt defaults to now()).
        });
      }
      return true;
    },
    async session({ session, user }) {
      session.user.id = user.id;
      // @ts-expect-error - augmenting session
      session.user.role = (user as { role?: string }).role ?? 'MEMBER';
      return session;
    },
  },
});
```

- [ ] **Step 5: Wire route handlers**

`app/api/auth/[...nextauth]/route.ts`:
```ts
import { handlers } from '@/lib/auth';

export const { GET, POST } = handlers;
```

- [ ] **Step 6: Add middleware to gate /(app) routes**

`middleware.ts`:
```ts
import { auth } from '@/lib/auth';

export default auth((req) => {
  const isAppRoute = req.nextUrl.pathname.startsWith('/dashboard');
  if (isAppRoute && !req.auth) {
    const url = new URL('/api/auth/signin', req.url);
    return Response.redirect(url);
  }
});

export const config = {
  matcher: ['/dashboard/:path*'],
};
```

- [ ] **Step 7: Add a typecheck pass**

```bash
pnpm typecheck
```

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: integrate Auth.js v5 with Authelia OIDC provider"
```

---

## Task 8: Authenticated dashboard

**Files:**
- Create: `app/(app)/layout.tsx`, `app/(app)/dashboard/page.tsx`

- [ ] **Step 1: Create the auth-gated layout**

`app/(app)/layout.tsx`:
```tsx
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect('/api/auth/signin');
  return (
    <div>
      <header style={{ padding: '1rem', borderBottom: '1px solid #ddd' }}>
        <strong>House Manager</strong>
        <span style={{ marginLeft: '1rem' }}>Signed in as {session.user.name}</span>
      </header>
      <main style={{ padding: '1rem' }}>{children}</main>
    </div>
  );
}
```

- [ ] **Step 2: Create the dashboard**

`app/(app)/dashboard/page.tsx`:
```tsx
import { auth } from '@/lib/auth';

export default async function Dashboard() {
  const session = await auth();
  return (
    <div>
      <h1>Hello, {session?.user?.name}</h1>
      <p>Foundation is ready. Core features arrive in subsequent plans.</p>
    </div>
  );
}
```

- [ ] **Step 3: Update app/page.tsx to redirect signed-in users**

```tsx
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';

export default async function Home() {
  const session = await auth();
  if (session?.user) redirect('/dashboard');
  return (
    <main style={{ padding: '2rem' }}>
      <h1>House Manager</h1>
      <a href="/api/auth/signin">Sign in</a>
    </main>
  );
}
```

- [ ] **Step 4: Manual smoke test**

```bash
pnpm dev
```

Visit `http://localhost:3000` → click "Sign in" → redirect to Authelia → sign in → land on `/dashboard` showing your name.

(If you don't have a real Authelia available locally, you can skip this manual test and rely on the mocked E2E test in Task 12.)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add authenticated dashboard"
```

---

## Task 9: Health endpoints

**Files:**
- Create: `app/api/health/route.ts`, `app/api/health/ready/route.ts`, `tests/integration/health.test.ts`, `tests/integration/setup.ts`

- [ ] **Step 1: Liveness — trivially returns OK**

`app/api/health/route.ts`:
```ts
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ status: 'ok' });
}
```

- [ ] **Step 2: Write the failing readiness test**

We'll use Testcontainers for integration tests. Install:
```bash
pnpm add -D testcontainers @testcontainers/postgresql
```

`tests/integration/setup.ts`:
```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';

export type TestStack = {
  postgres: StartedPostgreSqlContainer;
  meili: StartedTestContainer;
  databaseUrl: string;
  meiliUrl: string;
};

export async function startStack(): Promise<TestStack> {
  const postgres = await new PostgreSqlContainer('pgvector/pgvector:pg16')
    .withDatabase('housemanager')
    .withUsername('housemanager')
    .withPassword('test')
    .start();
  const meili = await new GenericContainer('getmeili/meilisearch:v1.10')
    .withEnvironment({ MEILI_MASTER_KEY: 'test', MEILI_ENV: 'development' })
    .withExposedPorts(7700)
    .start();
  return {
    postgres,
    meili,
    databaseUrl: postgres.getConnectionUri(),
    meiliUrl: `http://${meili.getHost()}:${meili.getMappedPort(7700)}`,
  };
}

export async function stopStack(stack: TestStack) {
  await stack.postgres.stop();
  await stack.meili.stop();
}
```

`tests/integration/health.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, stopStack, type TestStack } from './setup';
import { isReady } from '@/lib/health';

let stack: TestStack;

beforeAll(async () => {
  stack = await startStack();
}, 120_000);

afterAll(async () => {
  await stopStack(stack);
});

describe('readiness check', () => {
  it('returns ready when db and meilisearch reachable', async () => {
    const result = await isReady({ databaseUrl: stack.databaseUrl, meiliUrl: stack.meiliUrl });
    expect(result.ready).toBe(true);
    expect(result.checks.database).toBe('ok');
    expect(result.checks.meilisearch).toBe('ok');
  });

  it('returns not ready when db is unreachable', async () => {
    const result = await isReady({
      databaseUrl: 'postgresql://nope:nope@127.0.0.1:1/nope',
      meiliUrl: stack.meiliUrl,
    });
    expect(result.ready).toBe(false);
    expect(result.checks.database).not.toBe('ok');
  });
});
```

- [ ] **Step 3: Add separate vitest project for integration**

Update `vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // resolve is at the top level (not under `test`) so the alias applies in all projects.
  resolve: {
    alias: { '@': new URL('./', import.meta.url).pathname },
  },
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts', 'lib/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
```

Add scripts:
```json
{
  "scripts": {
    "test:unit": "vitest run --project unit",
    "test:integration": "vitest run --project integration"
  }
}
```

- [ ] **Step 4: Run the integration test, verify it fails**

```bash
pnpm test:integration
```

Expected: FAIL — `lib/health` does not exist.

- [ ] **Step 5: Implement lib/health.ts**

```ts
import { Client } from 'pg';

export type ReadyResult = {
  ready: boolean;
  checks: { database: string; meilisearch: string };
};

export async function isReady(opts: {
  databaseUrl: string;
  meiliUrl: string;
}): Promise<ReadyResult> {
  const checks = { database: 'unchecked', meilisearch: 'unchecked' };

  try {
    const client = new Client({ connectionString: opts.databaseUrl, connectionTimeoutMillis: 2000 });
    await client.connect();
    await client.query('SELECT 1');
    await client.end();
    checks.database = 'ok';
  } catch (e) {
    checks.database = `error: ${(e as Error).message}`;
  }

  try {
    const res = await fetch(`${opts.meiliUrl}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    checks.meilisearch = res.ok ? 'ok' : `error: HTTP ${res.status}`;
  } catch (e) {
    checks.meilisearch = `error: ${(e as Error).message}`;
  }

  return { ready: checks.database === 'ok' && checks.meilisearch === 'ok', checks };
}
```

Install `pg`:
```bash
pnpm add pg
pnpm add -D @types/pg
```

- [ ] **Step 6: Implement the readiness route**

`app/api/health/ready/route.ts`:
```ts
import { isReady } from '@/lib/health';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

export async function GET() {
  const result = await isReady({ databaseUrl: env.DATABASE_URL, meiliUrl: env.MEILI_HOST });
  return Response.json(result, { status: result.ready ? 200 : 503 });
}
```

- [ ] **Step 7: Run integration tests, verify they pass**

```bash
pnpm test:integration
```

Expected: 2 passing tests.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add health and readiness endpoints with integration tests"
```

---

## Task 10: Worker scaffold (pg-boss)

**Files:**
- Create: `worker/index.ts`, `worker/README.md`, `lib/queue.ts`
- Modify: `package.json`, `tsconfig.json`

- [ ] **Step 1: Install pg-boss**

```bash
pnpm add pg-boss
pnpm add -D @types/node
```

- [ ] **Step 2: Create lib/queue.ts**

```ts
import PgBoss from 'pg-boss';
import { env } from '@/lib/env';

let bossInstance: PgBoss | null = null;

export async function getBoss(): Promise<PgBoss> {
  if (bossInstance) return bossInstance;
  const boss = new PgBoss({ connectionString: env.DATABASE_URL });
  boss.on('error', (e) => console.error('pg-boss error', e));
  await boss.start();
  bossInstance = boss;
  return boss;
}

export async function stopBoss(): Promise<void> {
  if (bossInstance) {
    await bossInstance.stop({ graceful: true });
    bossInstance = null;
  }
}
```

- [ ] **Step 3: Create worker entrypoint**

`worker/index.ts`:
```ts
import { getBoss } from '@/lib/queue';

async function main() {
  const boss = await getBoss();
  console.log('worker: pg-boss started; no jobs registered yet (Plan 1 placeholder)');

  const shutdown = async (signal: string) => {
    console.log(`worker: received ${signal}, shutting down...`);
    await boss.stop({ graceful: true });
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  console.error('worker failed to start', e);
  process.exit(1);
});
```

- [ ] **Step 4: Create worker/README.md**

```markdown
# Worker

Run locally:
```
pnpm worker:dev
```

The worker connects to the same Postgres as the web app and uses pg-boss tables for the job queue. In Plan 1 it registers no jobs — it just verifies the queue can start.
```

- [ ] **Step 5: Add scripts**

```json
{
  "scripts": {
    "worker:dev": "tsx worker/index.ts",
    "worker:build": "tsc -p worker/tsconfig.json",
    "worker:start": "node dist/worker/index.js"
  }
}
```

Create `worker/tsconfig.json`:
```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "../dist/worker",
    "module": "esnext",
    "moduleResolution": "node",
    "target": "ES2022",
    "rootDir": "..",
    "incremental": false
  },
  "include": ["./**/*.ts", "../lib/**/*.ts"],
  "exclude": ["**/*.test.ts"]
}
```

- [ ] **Step 6: Smoke test the worker**

With db running:
```bash
pnpm worker:dev
```

Expected: log line `worker: pg-boss started ...`. Ctrl-C exits gracefully.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: scaffold pg-boss worker (no jobs yet)"
```

---

## Task 11: Dockerfile (production image)

**Files:**
- Create: `Dockerfile`, `.dockerignore`

- [ ] **Step 1: Create .dockerignore**

```
node_modules
.next
.git
.env
.env.local
data
playwright-report
test-results
coverage
docs
tests
```

- [ ] **Step 2: Create multi-stage Dockerfile**

```dockerfile
# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm db:generate
RUN pnpm build
RUN pnpm worker:build
RUN pnpm prune --prod

FROM node:22-alpine AS runtime
RUN corepack enable && apk add --no-cache curl
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -fsS http://localhost:3000/api/health || exit 1

CMD ["pnpm", "start"]
```

- [ ] **Step 3: Build the image**

```bash
docker build -t house-manager:dev .
```

Expected: image builds successfully (~2 min cold).

- [ ] **Step 4: Add web + worker services to docker-compose.yml**

Append to `docker-compose.yml`:
```yaml
  web:
    build: .
    image: house-manager:dev
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
      meilisearch:
        condition: service_healthy
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}
      AUTH_SECRET: ${AUTH_SECRET}
      AUTH_URL: ${AUTH_URL}
      AUTH_OIDC_ISSUER: ${AUTH_OIDC_ISSUER}
      AUTH_OIDC_CLIENT_ID: ${AUTH_OIDC_CLIENT_ID}
      AUTH_OIDC_CLIENT_SECRET: ${AUTH_OIDC_CLIENT_SECRET}
      MEILI_HOST: http://meilisearch:7700
      MEILI_KEY: ${MEILI_KEY}
      FILES_DIR: /data/files
      NODE_ENV: production
    volumes:
      - files:/data/files
    ports: ["3000:3000"]
    command: sh -c "pnpm db:deploy && pnpm start"

  worker:
    build: .
    image: house-manager:dev
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}
      AUTH_SECRET: ${AUTH_SECRET}
      AUTH_URL: ${AUTH_URL}
      AUTH_OIDC_ISSUER: ${AUTH_OIDC_ISSUER}
      AUTH_OIDC_CLIENT_ID: ${AUTH_OIDC_CLIENT_ID}
      AUTH_OIDC_CLIENT_SECRET: ${AUTH_OIDC_CLIENT_SECRET}
      MEILI_HOST: http://meilisearch:7700
      MEILI_KEY: ${MEILI_KEY}
      FILES_DIR: /data/files
      NODE_ENV: production
    volumes:
      - files:/data/files
    command: pnpm worker:start

volumes:
  pgdata:
  meilidata:
  files:
```

- [ ] **Step 5: Bring up the full stack**

```bash
docker compose up -d --build
sleep 10
curl -fsS http://localhost:3000/api/health
curl -fsS http://localhost:3000/api/health/ready
```

Expected: both return JSON with `"status":"ok"` / `"ready":true`.

- [ ] **Step 6: Tear down**

```bash
docker compose down
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add Dockerfile and complete docker-compose stack"
```

---

## Task 12: E2E test with mocked OIDC (Playwright)

**Files:**
- Create: `playwright.config.ts`, `tests/e2e/signin.spec.ts`, `tests/e2e/mock-oidc.ts`

- [ ] **Step 1: Install Playwright**

```bash
pnpm add -D @playwright/test
pnpm exec playwright install --with-deps chromium
```

- [ ] **Step 2: Create playwright.config.ts**

The mock OIDC server is started in `globalSetup` so it's already listening
when Next.js boots and Auth.js fetches OIDC discovery on the first sign-in.

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  use: {
    baseURL: 'http://localhost:3000',
    headless: true,
  },
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // Inherit env vars from the parent process; the CI env / local invocation
    // is responsible for setting AUTH_OIDC_ISSUER=http://localhost:9999.
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
```

- [ ] **Step 3: Build a minimal mock OIDC server**

`tests/e2e/mock-oidc.ts`:
```ts
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, createSign, randomBytes } from 'node:crypto';

export async function startMockOidc(port: number): Promise<{ server: Server; issuer: string }> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const kid = 'test-kid';
  const issuer = `http://localhost:${port}`;
  const sub = 'test-user-sub';
  const code = randomBytes(16).toString('hex');

  const sign = (payload: object) => {
    const header = { alg: 'RS256', kid, typ: 'JWT' };
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const data = `${enc(header)}.${enc(payload)}`;
    const signer = createSign('RSA-SHA256');
    signer.update(data);
    const sig = signer.sign(privateKey).toString('base64url');
    return `${data}.${sig}`;
  };

  const server = createServer((req, res) => {
    if (req.url?.startsWith('/.well-known/openid-configuration')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/auth`,
          token_endpoint: `${issuer}/token`,
          userinfo_endpoint: `${issuer}/userinfo`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
        }),
      );
      return;
    }
    if (req.url?.startsWith('/jwks')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [{ ...jwk, kid, use: 'sig', alg: 'RS256' }] }));
      return;
    }
    if (req.url?.startsWith('/auth')) {
      const url = new URL(req.url, issuer);
      const redirect = url.searchParams.get('redirect_uri');
      const state = url.searchParams.get('state');
      res.writeHead(302, { location: `${redirect}?code=${code}&state=${state}` });
      res.end();
      return;
    }
    if (req.url?.startsWith('/token') && req.method === 'POST') {
      const now = Math.floor(Date.now() / 1000);
      const idToken = sign({
        iss: issuer,
        sub,
        aud: 'house-manager',
        exp: now + 3600,
        iat: now,
        email: 'test@example.com',
        name: 'Test User',
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        access_token: 'access-token',
        id_token: idToken,
        token_type: 'Bearer',
        expires_in: 3600,
      }));
      return;
    }
    if (req.url?.startsWith('/userinfo')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sub, email: 'test@example.com', name: 'Test User' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));
  return { server, issuer };
}
```

- [ ] **Step 4: Add globalSetup/globalTeardown that start/stop the mock IdP**

`tests/e2e/global-setup.ts`:
```ts
import type { Server } from 'node:http';
import { startMockOidc } from './mock-oidc';

declare global {
  // eslint-disable-next-line no-var
  var __MOCK_OIDC__: Server | undefined;
}

export default async function globalSetup() {
  const { server } = await startMockOidc(9999);
  globalThis.__MOCK_OIDC__ = server;
}
```

`tests/e2e/global-teardown.ts`:
```ts
export default async function globalTeardown() {
  const server = globalThis.__MOCK_OIDC__;
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}
```

- [ ] **Step 5: Write the sign-in spec**

`tests/e2e/signin.spec.ts`:
```ts
import { test, expect } from '@playwright/test';

test('signs in via mock OIDC and lands on dashboard', async ({ page }) => {
  // Mock OIDC is already running (started in globalSetup on port 9999).
  // The webServer was launched with AUTH_OIDC_ISSUER=http://localhost:9999.
  await page.goto('/');
  await page.click('text=Sign in');
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.locator('h1')).toContainText('Hello, Test User');
});
```

> **Critical for CI:** The audience claim (`aud`) in `mock-oidc.ts` is hardcoded
> to `'house-manager'`. This **must** match `AUTH_OIDC_CLIENT_ID` exactly or
> Auth.js will reject the id_token. The CI workflow sets both correctly; if you
> change one, change the other.

> **Important:** This test requires the dev server to be started with `AUTH_OIDC_ISSUER=http://localhost:9999`. The CI workflow sets this; for local runs, prepend the env var.

- [ ] **Step 6: Add the script**

```json
{
  "scripts": { "test:e2e": "playwright test" }
}
```

- [ ] **Step 7: Run it locally (with the right env)**

```bash
AUTH_OIDC_ISSUER=http://localhost:9999 \
AUTH_OIDC_CLIENT_ID=house-manager \
AUTH_OIDC_CLIENT_SECRET=test \
pnpm test:e2e
```

Expected: 1 passing test.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "test: add Playwright E2E for OIDC sign-in (mock IdP)"
```

---

## Task 13: lefthook pre-commit hooks

**Files:**
- Create: `lefthook.yml`

- [ ] **Step 1: Install lefthook**

```bash
pnpm add -D lefthook
pnpm exec lefthook install
```

- [ ] **Step 2: Create lefthook.yml**

```yaml
pre-commit:
  parallel: true
  commands:
    biome:
      glob: '*.{ts,tsx,js,jsx,json}'
      run: pnpm exec biome check --staged --no-errors-on-unmatched {staged_files}
    typecheck:
      glob: '*.{ts,tsx}'
      run: pnpm typecheck

pre-push:
  commands:
    test-changed:
      run: pnpm test:unit
```

- [ ] **Step 3: Verify hooks installed**

```bash
ls -la .git/hooks/pre-commit
```

Expected: file exists, owned by lefthook.

- [ ] **Step 4: Commit (this should trigger the hook)**

```bash
git add -A
git commit -m "chore: add lefthook pre-commit hooks"
```

Expected: hooks run, lint + typecheck pass.

---

## Task 14: GitHub Actions CI

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create the workflow**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  setup:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm db:generate

  lint:
    needs: setup
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint

  typecheck:
    needs: setup
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm db:generate
      - run: pnpm typecheck

  migrate-check:
    needs: setup
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --exit-code

  unit:
    needs: setup
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm db:generate
      - run: pnpm test:unit

  integration:
    needs: setup
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm db:generate
      - run: pnpm test:integration

  e2e:
    needs: setup
    runs-on: ubuntu-latest
    services:
      db:
        image: pgvector/pgvector:pg16
        env:
          POSTGRES_USER: housemanager
          POSTGRES_PASSWORD: test
          POSTGRES_DB: housemanager
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U housemanager"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
      meilisearch:
        image: getmeili/meilisearch:v1.10
        env:
          MEILI_MASTER_KEY: test
          MEILI_ENV: development
        ports: ["7700:7700"]
    env:
      DATABASE_URL: postgresql://housemanager:test@localhost:5432/housemanager
      AUTH_SECRET: ${{ secrets.AUTH_SECRET || 'a-very-long-secret-for-ci-only-not-real-use' }}
      AUTH_URL: http://localhost:3000
      AUTH_OIDC_ISSUER: http://localhost:9999
      AUTH_OIDC_CLIENT_ID: house-manager
      AUTH_OIDC_CLIENT_SECRET: test
      MEILI_HOST: http://localhost:7700
      MEILI_KEY: test
      FILES_DIR: /tmp/files
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm db:generate
      - run: pnpm db:deploy
      - run: pnpm exec playwright install --with-deps chromium
      - run: pnpm test:e2e

  build:
    needs: [lint, typecheck, migrate-check, unit, integration, e2e]
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: |
            ghcr.io/${{ github.repository }}:${{ github.sha }}
            ghcr.io/${{ github.repository }}:latest
```

- [ ] **Step 2: Push and verify CI is green**

```bash
git add -A
git commit -m "ci: add GitHub Actions workflow"
git push -u origin main
```

Then visit the Actions tab — all jobs should go green.

> **Note:** if there's no remote yet, this task ends with the commit; pushing/verifying CI requires a GitHub repo. Create one and add as `origin` first.

---

## Task 15: project orientation README

**Files:**
- Create: `docs/README.md`

- [ ] **Step 1: Create docs/README.md**

```markdown
# House Manager

Self-hosted home information manager. See `superpowers/specs/2026-04-26-house-manager-design.md` for the full design and `superpowers/plans/` for implementation plans.

## Quick start (development)

```bash
cp .env.example .env
# Edit .env: set AUTH_SECRET, MEILI_KEY/MEILI_MASTER_KEY, and Authelia OIDC vars.
pnpm install
docker compose up -d db meilisearch
pnpm db:migrate
pnpm dev          # web (in one terminal)
pnpm worker:dev   # worker (in another)
```

## Production

```bash
docker compose up -d
```

## Scripts

- `pnpm verify` — lint + typecheck + unit tests (run before pushing).
- `pnpm test:integration` — Testcontainers-backed; needs Docker.
- `pnpm test:e2e` — Playwright; requires the dev server (auto-starts) and a mock OIDC.

## Plans status

- [x] Plan 1: Foundation — this plan
- [ ] Plan 2: Core CRUD + Attachments
- [ ] Plan 3: Reminders, Checklists & Notifications
- [ ] Plan 4: AI (Find, Ask, Suggest, OCR)
- [ ] Plan 5: Polish & Operations
```

- [ ] **Step 2: Add a top-level `pnpm verify` script**

In `package.json`:
```json
{
  "scripts": {
    "verify": "pnpm lint && pnpm typecheck && pnpm test:unit"
  }
}
```

- [ ] **Step 3: Final verification run**

```bash
pnpm verify
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: add project orientation README"
```

---

## Task 16: Re-sign all commits and re-enable signing

This branch was developed with `commit.gpgsign=false` set locally for the repo, because the implementer subagents commit non-interactively and the user's `op-ssh-sign` (1Password) signing program requires interactive approval that doesn't surface in the agent shell. Each agent-attempted signed commit silently produced an unsigned commit. We disabled signing for the duration of Plan 1 and resign in one batch at the end.

(Authors were already normalized to the global config `owine <owine@users.noreply.github.com>` mid-development via a `--reset-author` rebase, so this task only needs to add signatures.)

**Files:** none modified — this is a git history operation.

- [ ] **Step 1: Re-enable signing for the repo**

```bash
git config commit.gpgsign true
git config --get commit.gpgsign  # should print: true
```

- [ ] **Step 2: Pre-approve in 1Password (optional, makes the rebase smoother)**

Open 1Password → Settings → Developer → SSH Agent and toggle "Allow signing without authorization for 5 minutes" (or use Touch ID approval per commit; the rebase will pause for each).

- [ ] **Step 3: Rebase plan-1-foundation from the root, signing each commit**

```bash
git checkout plan-1-foundation
git rebase --root --exec 'git commit --amend --no-edit -S --no-verify'
```

This rewrites every commit on the branch (~16 commits including main's 2 docs commits) with a signature. 1Password may prompt you 16 times unless you pre-approved in Step 2.

- [ ] **Step 4: Re-point `main` at the rewritten equivalent of its old HEAD**

The original `main` had 2 commits (spec + plan). Those are now the first two commits on `plan-1-foundation`. Move main forward:

```bash
# Count of task commits on plan-1-foundation past main = 14 (Tasks 1–15 minus the
# tasks that didn't produce a commit, plus this resign task itself which produces 0).
# Just look at the log and pick the new SHA of the "docs: add Plan 1" commit.
git log plan-1-foundation --oneline | head -20
# Find the SHA of "docs: add Plan 1 (foundation) implementation plan" — let's call it $PLAN_SHA
git branch -f main $PLAN_SHA
```

Or, equivalently if the math holds (one commit per task plus the spec + plan docs):
```bash
# 14 commits past main: 11 task commits + 3 fixups (Task 2 amend, Task 6 amend, Task 9 amend) — adjust based on actual git log.
git log plan-1-foundation --oneline | wc -l   # total commits
git log main --oneline | wc -l                # original main count (2 before resign)
# main should point at HEAD~(total - 2) after resign
```

The "look at the log and pick the SHA" approach is the safest.

- [ ] **Step 5: Verify all commits are signed**

```bash
git log --show-signature --oneline | head -20
```

Every line that previously said "No signature" should now show a signature. The `error: gpg.ssh.allowedSignersFile needs to be configured` message is harmless — it's a verification config, not a signing one. (If you want to silence it, configure `gpg.ssh.allowedSignersFile` per Git docs.)

- [ ] **Step 6: Commit the resign — wait, no, there's nothing to commit**

The rebase already rewrote history. No new commit needed for this task.

## Done criteria

- [ ] `pnpm install && pnpm verify` passes from a fresh clone.
- [ ] `docker compose up -d --build && curl -fsS http://localhost:3000/api/health/ready` returns `{"ready":true,...}`.
- [ ] Visiting `http://localhost:3000` while signed in via Authelia lands on `/dashboard` with "Hello, &lt;name&gt;".
- [ ] CI runs lint, typecheck, migrate-check, unit, integration, e2e jobs in parallel and is green on main.
- [ ] Plan 2 has a clear starting point (an empty Items/Vendors/Warranties surface area).

## Notes for the implementer

- **Authelia client config:** the redirect URI to register on the Authelia side is `${AUTH_URL}/api/auth/callback/authelia`. Scopes: `openid profile email groups`.
- **Why pgvector image now even though we use no vectors yet:** so subsequent plans don't require a database migration to a different image. Same applies to Meilisearch.
- **Why no real OIDC in CI:** running Authelia in CI is heavy and brittle. The mock IdP gives us auth-flow coverage without the operational load.
- **DRY/YAGNI:** resist the urge to scaffold Items/Vendors/Reminders models in this plan — they belong to Plan 2/3 where their tests will live alongside them.
- **Commit cadence:** one commit per task as scripted above. If a task breaks down further during implementation, smaller commits within it are fine.
