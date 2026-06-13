# Uang — Plan 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a deployable, authenticated, single-household app shell (TanStack Router SPA + ElysiaJS/Bun API + libSQL/Drizzle + better-auth) with first-run onboarding and a fully unit-tested BigInt money/currency core.

**Architecture:** Bun-workspace monorepo with three packages: `apps/web` (Vite SPA, shadcn/ui + Tailwind), `apps/api` (ElysiaJS on Bun, libSQL file DB via Drizzle, better-auth), and `packages/shared` (pure TypeScript money/currency logic + shared types). The API is the single source of truth; the SPA talks to it type-safely via Eden Treaty. SQLite lives on a persistent volume in production.

**Tech Stack:** Bun, TypeScript, ElysiaJS, `@libsql/client`, Drizzle ORM + drizzle-kit, better-auth, Vite, React, TanStack Router, TanStack DB, Tailwind CSS v4, shadcn/ui, Eden Treaty. Tests: `bun test`.

> **Scope:** Plan 1 of 3. Accounts/ledger/net-worth (Plan 2) and holdings (Plan 3) are NOT in this plan. This plan ends with: you can open the web app, complete first-run onboarding (household name + base currency + admin user), log in/out, and the money core lib passes its test suite. The DB schema for later slices is created now so migrations are stable.

---

## File Structure

```
uang/
├── package.json                 # workspace root (bun workspaces)
├── tsconfig.base.json           # shared compiler options
├── .gitignore
├── .env.example
├── packages/shared/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── money.ts             # BigInt minor-unit math, roundDiv, convertToBase
│       ├── money.test.ts        # unit tests for money.ts
│       ├── currencies.ts        # ISO-4217 minor-unit digit map
│       ├── currencies.test.ts
│       └── index.ts             # re-exports
├── apps/api/
│   ├── package.json
│   ├── tsconfig.json
│   ├── drizzle.config.ts
│   ├── Dockerfile
│   └── src/
│       ├── db/
│       │   ├── schema.ts        # Drizzle tables (settings, accounts, entries, instruments, lots, prices, fx_rates + auth tables)
│       │   ├── client.ts        # libSQL + drizzle instance
│       │   └── migrate.ts       # run migrations on boot
│       ├── auth.ts              # better-auth config
│       ├── routes/
│       │   ├── onboarding.ts    # first-run: create settings + admin
│       │   └── onboarding.test.ts
│       ├── lib/
│       │   └── settings.ts      # read/write the singleton settings row
│       ├── app.ts               # Elysia app (composes routes, auth, cors)
│       └── index.ts             # server entrypoint (migrate then listen)
└── apps/web/
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── components.json          # shadcn config
    ├── Dockerfile
    └── src/
        ├── main.tsx             # router + providers bootstrap
        ├── index.css            # tailwind entry
        ├── lib/
        │   ├── api.ts           # Eden Treaty client
        │   └── auth.ts          # better-auth react client
        ├── router.tsx           # TanStack Router route tree
        └── routes/
            ├── onboarding.tsx
            ├── login.tsx
            └── dashboard.tsx    # placeholder "logged in" page (real dashboard = Plan 2)
```

---

## Task 1: Workspace root & tooling

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `.gitignore`, `.env.example`

- [ ] **Step 1: Create the workspace root `package.json`**

```json
{
  "name": "uang",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*", "apps/*"],
  "scripts": {
    "test": "bun test",
    "api:dev": "bun --cwd apps/api run dev",
    "web:dev": "bun --cwd apps/web run dev",
    "db:generate": "bun --cwd apps/api run db:generate",
    "db:migrate": "bun --cwd apps/api run db:migrate"
  }
}
```

- [ ] **Step 2: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "verbatimModuleSyntax": true,
    "types": ["bun-types"]
  }
}
```

- [ ] **Step 3: Create `.gitignore`**

```
node_modules
dist
*.local
.env
.env.*
!.env.example
data/
*.db
*.db-*
.DS_Store
```

- [ ] **Step 4: Create `.env.example`**

```
# apps/api
DATABASE_URL=file:./data/uang.db
BETTER_AUTH_SECRET=change-me-in-production
BETTER_AUTH_URL=http://localhost:3000
WEB_ORIGIN=http://localhost:5173
# apps/web
VITE_API_URL=http://localhost:3000
```

- [ ] **Step 5: Install Bun (if needed) and verify**

Run: `bun --version`
Expected: a version string (e.g. `1.x.x`). If missing, install from https://bun.sh.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.base.json .gitignore .env.example
git commit -m "chore: workspace root and tooling config"
```

---

## Task 2: Currency minor-unit map (`packages/shared`)

**Files:**
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/currencies.ts`, `packages/shared/src/currencies.test.ts`

- [ ] **Step 1: Create `packages/shared/package.json`**

```json
{
  "name": "@uang/shared",
  "version": "0.0.0",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "exports": { ".": "./src/index.ts" }
}
```

- [ ] **Step 2: Create `packages/shared/tsconfig.json`**

```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

- [ ] **Step 3: Write the failing test `packages/shared/src/currencies.test.ts`**

```ts
import { expect, test } from "bun:test";
import { currencyDecimals } from "./currencies";

test("known minor-unit digits", () => {
  expect(currencyDecimals("USD")).toBe(2);
  expect(currencyDecimals("MYR")).toBe(2);
  expect(currencyDecimals("JPY")).toBe(0);
  expect(currencyDecimals("BHD")).toBe(3);
});

test("is case-insensitive", () => {
  expect(currencyDecimals("jpy")).toBe(0);
});

test("defaults unknown codes to 2", () => {
  expect(currencyDecimals("ZZZ")).toBe(2);
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `bun test packages/shared/src/currencies.test.ts`
Expected: FAIL — cannot find module `./currencies`.

- [ ] **Step 5: Implement `packages/shared/src/currencies.ts`**

```ts
// ISO 4217 minor-unit digits for currencies that differ from the default of 2,
// plus common 2-digit ones for clarity. Unknown codes default to 2.
const MINOR_UNITS: Record<string, number> = {
  USD: 2, EUR: 2, GBP: 2, MYR: 2, SGD: 2, AUD: 2, CAD: 2, CHF: 2,
  IDR: 2, INR: 2, CNY: 2, HKD: 2, THB: 2, PHP: 2,
  JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0,
  BHD: 3, KWD: 3, OMR: 3, JOD: 3, TND: 3,
};

export function currencyDecimals(code: string): number {
  const d = MINOR_UNITS[code.toUpperCase()];
  return d === undefined ? 2 : d;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test packages/shared/src/currencies.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/shared/package.json packages/shared/tsconfig.json packages/shared/src/currencies.ts packages/shared/src/currencies.test.ts
git commit -m "feat(shared): currency minor-unit digit map"
```

---

## Task 3: BigInt money core — `roundDiv` (banker's rounding)

**Files:**
- Create: `packages/shared/src/money.ts`, `packages/shared/src/money.test.ts`

- [ ] **Step 1: Write the failing test `packages/shared/src/money.test.ts`**

```ts
import { expect, test } from "bun:test";
import { roundDiv } from "./money";

test("exact division", () => {
  expect(roundDiv(10n, 2n)).toBe(5n);
});

test("rounds down below half", () => {
  expect(roundDiv(7n, 5n)).toBe(1n); // 1.4 -> 1
});

test("rounds up above half", () => {
  expect(roundDiv(9n, 5n)).toBe(2n); // 1.8 -> 2
});

test("half rounds to even", () => {
  expect(roundDiv(5n, 2n)).toBe(2n); // 2.5 -> 2 (even)
  expect(roundDiv(15n, 2n)).toBe(8n); // 7.5 -> 8 (even)
});

test("handles negatives symmetrically", () => {
  expect(roundDiv(-5n, 2n)).toBe(-2n); // -2.5 -> -2 (even)
  expect(roundDiv(-9n, 5n)).toBe(-2n); // -1.8 -> -2
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/shared/src/money.test.ts`
Expected: FAIL — cannot find module `./money`.

- [ ] **Step 3: Implement `roundDiv` in `packages/shared/src/money.ts`**

```ts
export const SCALE = 100_000_000n; // 1e8: shared scale for rates, prices, units

// Divide num/den with round-half-to-even (banker's rounding). den must be > 0.
export function roundDiv(num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new Error("roundDiv: denominator must be positive");
  const neg = num < 0n;
  const a = neg ? -num : num;
  const q = a / den;
  const rem = a - q * den;
  const twice = rem * 2n;
  let result = q;
  if (twice > den) result = q + 1n;
  else if (twice === den && q % 2n === 1n) result = q + 1n;
  return neg ? -result : result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/shared/src/money.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/money.ts packages/shared/src/money.test.ts
git commit -m "feat(shared): roundDiv with banker's rounding"
```

---

## Task 4: BigInt money core — `convertToBase`

**Files:**
- Modify: `packages/shared/src/money.ts`, `packages/shared/src/money.test.ts`

- [ ] **Step 1: Add failing tests to `packages/shared/src/money.test.ts`**

Append:

```ts
import { convertToBase } from "./money";

const TEN_POW = (n: number) => 10n ** BigInt(n);

test("base currency converts 1:1 regardless of rate arg", () => {
  // 12345 USD-minor (=$123.45) to USD base
  expect(convertToBase(12345n, "USD", "USD", SCALE)).toBe(12345n);
});

test("same decimals, simple rate (USD->MYR at 4.5)", () => {
  // $100.00 = 10000 minor; rate 4.5 -> RM450.00 = 45000 minor
  const rate = 45n * SCALE / 10n; // 4.5 * 1e8
  expect(convertToBase(10000n, "USD", "MYR", rate)).toBe(45000n);
});

test("fewer source decimals (JPY 0-dec -> USD 2-dec)", () => {
  // 1000 JPY (units, 0 decimals) at 0.0067 USD/JPY -> 6.70 USD = 670 minor
  const rate = 67n * SCALE / 10000n; // 0.0067 * 1e8
  expect(convertToBase(1000n, "JPY", "USD", rate)).toBe(670n);
});

test("more source decimals (BHD 3-dec -> USD 2-dec)", () => {
  // 1.500 BHD = 1500 minor at 2.65 USD/BHD -> 3.975 -> 398 (round half even) USD minor
  const rate = 265n * SCALE / 100n; // 2.65 * 1e8
  expect(convertToBase(1500n, "BHD", "USD", rate)).toBe(398n);
});

test("negative amounts (liabilities) convert correctly", () => {
  const rate = 45n * SCALE / 10n;
  expect(convertToBase(-10000n, "USD", "MYR", rate)).toBe(-45000n);
});
```

- [ ] **Step 2: Run test to verify the new tests fail**

Run: `bun test packages/shared/src/money.test.ts`
Expected: FAIL — `convertToBase` is not exported.

- [ ] **Step 3: Implement `convertToBase` in `packages/shared/src/money.ts`**

Append:

```ts
import { currencyDecimals } from "./currencies";

// Convert an amount in `from` currency minor units to `base` currency minor units.
// rateScaled = (base major per 1 from-major) * SCALE. For from === base, pass SCALE.
// base_minor = round( amountMinor * 10^baseDec * rateScaled / (10^fromDec * SCALE) )
export function convertToBase(
  amountMinor: bigint,
  from: string,
  base: string,
  rateScaled: bigint,
): bigint {
  if (from.toUpperCase() === base.toUpperCase()) return amountMinor;
  const fromDec = BigInt(currencyDecimals(from));
  const baseDec = BigInt(currencyDecimals(base));
  const num = amountMinor * 10n ** baseDec * rateScaled;
  const den = 10n ** fromDec * SCALE;
  return roundDiv(num, den);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/shared/src/money.test.ts`
Expected: PASS (all money tests).

- [ ] **Step 5: Create `packages/shared/src/index.ts`**

```ts
export * from "./money";
export * from "./currencies";
```

- [ ] **Step 6: Run the whole shared suite**

Run: `bun test packages/shared`
Expected: PASS (currencies + money).

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/money.ts packages/shared/src/money.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): convertToBase multi-currency conversion"
```

---

## Task 5: API package & Drizzle schema

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/drizzle.config.ts`, `apps/api/src/db/schema.ts`

- [ ] **Step 1: Create `apps/api/package.json`**

```json
{
  "name": "@uang/api",
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "bun run --watch src/index.ts",
    "start": "bun run src/index.ts",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "bun run src/db/migrate.ts"
  },
  "dependencies": {
    "@uang/shared": "workspace:*",
    "elysia": "latest",
    "@elysiajs/cors": "latest",
    "@libsql/client": "latest",
    "drizzle-orm": "latest",
    "better-auth": "latest"
  },
  "devDependencies": {
    "drizzle-kit": "latest"
  }
}
```

- [ ] **Step 2: Create `apps/api/tsconfig.json`**

```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "jsx": "preserve" }, "include": ["src", "drizzle.config.ts"] }
```

- [ ] **Step 3: Install deps**

Run: `bun install`
Expected: installs without error; `apps/api/node_modules` populated via workspace.

- [ ] **Step 4: Write `apps/api/src/db/schema.ts` (app tables)**

```ts
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey(), // always 1
  householdName: text("household_name").notNull(),
  baseCurrency: text("base_currency").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  class: text("class").notNull(), // 'asset' | 'liability'
  subtype: text("subtype").notNull(),
  currency: text("currency").notNull(),
  valuationMode: text("valuation_mode").notNull(), // 'ledger' | 'holdings'
  institution: text("institution"),
  isArchived: integer("is_archived").notNull().default(0),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  createdBy: text("created_by").notNull(),
});

export const entries = sqliteTable("entries", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  date: text("date").notNull(), // YYYY-MM-DD
  amountMinor: integer("amount_minor").notNull(),
  kind: text("kind").notNull(), // 'opening'|'adjustment'|'revaluation'|'transaction'
  note: text("note"),
  createdAt: integer("created_at").notNull(),
  createdBy: text("created_by").notNull(),
});

export const instruments = sqliteTable("instruments", {
  id: text("id").primaryKey(),
  symbol: text("symbol"),
  isin: text("isin"),
  name: text("name").notNull(),
  kind: text("kind").notNull(), // 'stock'|'etf'|'fund'|'other'
  currency: text("currency").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const lots = sqliteTable("lots", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  instrumentId: text("instrument_id").notNull(),
  unitsScaled: integer("units_scaled").notNull(),
  unitCostScaled: integer("unit_cost_scaled").notNull(),
  feesMinor: integer("fees_minor").notNull().default(0),
  tradeDate: text("trade_date").notNull(),
  note: text("note"),
  createdAt: integer("created_at").notNull(),
  createdBy: text("created_by").notNull(),
});

export const prices = sqliteTable("prices", {
  id: text("id").primaryKey(),
  instrumentId: text("instrument_id").notNull(),
  date: text("date").notNull(),
  priceScaled: integer("price_scaled").notNull(),
  source: text("source").notNull().default("manual"),
  createdAt: integer("created_at").notNull(),
});

export const fxRates = sqliteTable("fx_rates", {
  id: text("id").primaryKey(),
  currency: text("currency").notNull(),
  date: text("date").notNull(),
  rateScaled: integer("rate_scaled").notNull(),
  createdAt: integer("created_at").notNull(),
});
```

> Note: `integer` columns hold values that fit in 64-bit (SQLite INTEGER). Money minor units, `*_scaled` (1e8), and epoch timestamps all fit. Drizzle returns them as JS numbers; convert to BigInt at the math boundary (money lib). Amounts beyond 2^53 are not expected at household scale; Plan 2 documents the boundary helper.

- [ ] **Step 5: Create `apps/api/drizzle.config.ts`**

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "file:./data/uang.db" },
});
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/package.json apps/api/tsconfig.json apps/api/drizzle.config.ts apps/api/src/db/schema.ts bun.lock
git commit -m "feat(api): package setup and Drizzle app schema"
```

---

## Task 6: better-auth config & auth tables

**Files:**
- Create: `apps/api/src/auth.ts`
- Modify: `apps/api/src/db/schema.ts` (append generated auth tables)

- [ ] **Step 1: Create `apps/api/src/db/client.ts`**

```ts
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";

const url = process.env.DATABASE_URL ?? "file:./data/uang.db";
export const sqlite = createClient({ url });
export const db = drizzle(sqlite, { schema });
export type DB = typeof db;
```

- [ ] **Step 2: Create `apps/api/src/auth.ts`**

```ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "./db/client";

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "sqlite" }),
  emailAndPassword: {
    enabled: true,
    // Open sign-up is gated by the onboarding flow + an admin-only invite path
    // (enforced in routes). better-auth itself allows sign-up; we wrap it.
  },
  user: {
    additionalFields: {
      isAdmin: { type: "boolean", required: false, defaultValue: false, input: false },
    },
  },
  trustedOrigins: [process.env.WEB_ORIGIN ?? "http://localhost:5173"],
  secret: process.env.BETTER_AUTH_SECRET ?? "dev-secret",
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
});
```

- [ ] **Step 3: Generate the better-auth Drizzle tables into the schema**

Run: `bunx @better-auth/cli generate --config apps/api/src/auth.ts --output apps/api/src/db/auth-schema.ts -y`
Expected: writes `auth-schema.ts` with `user`, `session`, `account`, `verification` tables (including the `isAdmin` field).

- [ ] **Step 4: Re-export auth tables from `schema.ts`**

Append to `apps/api/src/db/schema.ts`:

```ts
export * from "./auth-schema";
```

- [ ] **Step 5: Generate the SQL migration**

Run: `bun run --cwd apps/api db:generate`
Expected: a migration file appears in `apps/api/drizzle/` containing all app + auth tables.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/auth.ts apps/api/src/db/client.ts apps/api/src/db/auth-schema.ts apps/api/src/db/schema.ts apps/api/drizzle
git commit -m "feat(api): better-auth config and auth tables"
```

---

## Task 7: Migrate-on-boot & Elysia app skeleton

**Files:**
- Create: `apps/api/src/db/migrate.ts`, `apps/api/src/app.ts`, `apps/api/src/index.ts`

- [ ] **Step 1: Create `apps/api/src/db/migrate.ts`**

```ts
import { migrate } from "drizzle-orm/libsql/migrator";
import { db, sqlite } from "./client";

export async function runMigrations() {
  await migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
}

// Allow running directly: `bun run src/db/migrate.ts`
if (import.meta.main) {
  await runMigrations();
  sqlite.close();
  console.log("migrations applied");
}
```

- [ ] **Step 2: Create `apps/api/src/app.ts`**

```ts
import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { auth } from "./auth";

export function createApp() {
  return new Elysia()
    .use(cors({
      origin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
      credentials: true,
    }))
    .get("/health", () => ({ ok: true }))
    // Mount better-auth's handler at /api/auth/*
    .mount("/api/auth", auth.handler);
}

export type App = ReturnType<typeof createApp>;
```

- [ ] **Step 3: Create `apps/api/src/index.ts`**

```ts
import { runMigrations } from "./db/migrate";
import { createApp } from "./app";

const ephemeral = (process.env.DATABASE_URL ?? "").includes("/tmp/");
if (process.env.NODE_ENV === "production" && (ephemeral || !process.env.DATABASE_URL)) {
  throw new Error("Refusing to start in production without a persistent DATABASE_URL");
}

await runMigrations();
const app = createApp();
const port = Number(process.env.PORT ?? 3000);
app.listen(port);
console.log(`API listening on :${port}`);
```

- [ ] **Step 4: Verify the server boots and migrates**

Run: `cd apps/api && DATABASE_URL=file:./data/test-boot.db bun run src/index.ts &` then `sleep 1 && curl -s localhost:3000/health`
Expected: `{"ok":true}`. Then stop the server (`kill %1`) and `rm -f apps/api/data/test-boot.db*`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/migrate.ts apps/api/src/app.ts apps/api/src/index.ts
git commit -m "feat(api): migrate-on-boot and Elysia app with auth mount"
```

---

## Task 8: Settings helper & onboarding route (TDD)

**Files:**
- Create: `apps/api/src/lib/settings.ts`, `apps/api/src/routes/onboarding.ts`, `apps/api/src/routes/onboarding.test.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Create `apps/api/src/lib/settings.ts`**

```ts
import { db } from "../db/client";
import { settings } from "../db/schema";
import { eq } from "drizzle-orm";

export async function getSettings() {
  const rows = await db.select().from(settings).where(eq(settings.id, 1));
  return rows[0] ?? null;
}

export async function isInitialized(): Promise<boolean> {
  return (await getSettings()) !== null;
}
```

- [ ] **Step 2: Write the failing test `apps/api/src/routes/onboarding.test.ts`**

```ts
import { expect, test, beforeEach } from "bun:test";
import { createApp } from "../app";
import { runMigrations } from "../db/migrate";
import { db } from "../db/client";
import { settings, user } from "../db/schema";

// Use a fresh in-memory-ish file per run via env set before import is not possible here;
// these tests assume DATABASE_URL points at a disposable file (see run command).
beforeEach(async () => {
  await runMigrations();
  await db.delete(settings);
  await db.delete(user);
});

test("status reports uninitialized when no settings row", async () => {
  const app = createApp();
  const res = await app.handle(new Request("http://x/onboarding/status"));
  expect(await res.json()).toEqual({ initialized: false });
});

test("init creates settings + admin user, and blocks a second init", async () => {
  const app = createApp();
  const body = JSON.stringify({
    householdName: "Safudin",
    baseCurrency: "MYR",
    email: "a@b.com",
    name: "Aziz",
    password: "supersecret1",
  });
  const res = await app.handle(new Request("http://x/onboarding/init", {
    method: "POST", headers: { "content-type": "application/json" }, body,
  }));
  expect(res.status).toBe(200);

  const s = await db.select().from(settings);
  expect(s.length).toBe(1);
  expect(s[0].baseCurrency).toBe("MYR");
  const u = await db.select().from(user);
  expect(u.length).toBe(1);
  expect(u[0].isAdmin).toBe(true);

  // second attempt is rejected
  const res2 = await app.handle(new Request("http://x/onboarding/init", {
    method: "POST", headers: { "content-type": "application/json" }, body,
  }));
  expect(res2.status).toBe(409);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/api && DATABASE_URL=file:./data/test.db bun test src/routes/onboarding.test.ts`
Expected: FAIL — onboarding routes not mounted (404), or import error for the route file.

- [ ] **Step 4: Implement `apps/api/src/routes/onboarding.ts`**

```ts
import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { settings, user } from "../db/schema";
import { eq } from "drizzle-orm";
import { auth } from "../auth";
import { isInitialized } from "../lib/settings";

export const onboarding = new Elysia({ prefix: "/onboarding" })
  .get("/status", async () => ({ initialized: await isInitialized() }))
  .post(
    "/init",
    async ({ body, set }) => {
      if (await isInitialized()) { set.status = 409; return { error: "already_initialized" }; }

      // Create the first user via better-auth so the password is hashed correctly.
      await auth.api.signUpEmail({
        body: { email: body.email, name: body.name, password: body.password },
      });
      const created = await db.select().from(user).where(eq(user.email, body.email));
      await db.update(user).set({ isAdmin: true }).where(eq(user.id, created[0].id));

      await db.insert(settings).values({
        id: 1,
        householdName: body.householdName,
        baseCurrency: body.baseCurrency.toUpperCase(),
        createdAt: Math.floor(Date.now() / 1000),
      });
      return { ok: true };
    },
    {
      body: t.Object({
        householdName: t.String({ minLength: 1 }),
        baseCurrency: t.String({ minLength: 3, maxLength: 3 }),
        email: t.String(),
        name: t.String({ minLength: 1 }),
        password: t.String({ minLength: 8 }),
      }),
    },
  );
```

- [ ] **Step 5: Mount the route in `apps/api/src/app.ts`**

Add the import and `.use(onboarding)`:

```ts
import { onboarding } from "./routes/onboarding";
// ... inside createApp(), chain before `.mount(...)`:
//   .use(onboarding)
```

The chain becomes: `new Elysia().use(cors(...)).get("/health", ...).use(onboarding).mount("/api/auth", auth.handler)`.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd apps/api && DATABASE_URL=file:./data/test.db bun test src/routes/onboarding.test.ts`
Expected: PASS (2 tests). Then `rm -f apps/api/data/test.db*`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/settings.ts apps/api/src/routes/onboarding.ts apps/api/src/routes/onboarding.test.ts apps/api/src/app.ts
git commit -m "feat(api): first-run onboarding (settings + admin user)"
```

---

## Task 9: Gate sign-up after first user

**Files:**
- Create: `apps/api/src/routes/onboarding.test.ts` already covers init; add a guard test here.
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Write the failing test (append to `apps/api/src/routes/onboarding.test.ts`)**

```ts
test("public sign-up is blocked once initialized", async () => {
  const app = createApp();
  // initialize first
  await app.handle(new Request("http://x/onboarding/init", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ householdName: "H", baseCurrency: "MYR", email: "admin@x.com", name: "A", password: "supersecret1" }),
  }));
  // attempt a direct sign-up against the auth mount
  const res = await app.handle(new Request("http://x/api/auth/sign-up/email", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "intruder@x.com", name: "X", password: "supersecret1" }),
  }));
  expect(res.status).toBe(403);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && DATABASE_URL=file:./data/test.db bun test src/routes/onboarding.test.ts`
Expected: FAIL — sign-up returns 200, not 403.

- [ ] **Step 3: Add a guard before the auth mount in `apps/api/src/app.ts`**

```ts
import { isInitialized } from "./lib/settings";

// inside createApp(), BEFORE `.mount("/api/auth", auth.handler)`:
.onBeforeHandle(async ({ request, set }) => {
  const url = new URL(request.url);
  if (url.pathname === "/api/auth/sign-up/email" && (await isInitialized())) {
    set.status = 403;
    return { error: "signup_closed" };
  }
})
```

> After first-run, new users are created by an admin via an admin-only invite endpoint (Plan 2). Public sign-up stays closed.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && DATABASE_URL=file:./data/test.db bun test src/routes/onboarding.test.ts`
Expected: PASS (3 tests). Then `rm -f apps/api/data/test.db*`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/app.ts apps/api/src/routes/onboarding.test.ts
git commit -m "feat(api): close public sign-up after first run"
```

---

## Task 10: Web SPA scaffold (Vite + TanStack Router + Tailwind v4 + shadcn)

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/src/index.css`, `apps/web/src/main.tsx`, `apps/web/src/router.tsx`, `apps/web/components.json`

- [ ] **Step 1: Create `apps/web/package.json`**

```json
{
  "name": "@uang/web",
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview --host --port 4173"
  },
  "dependencies": {
    "@uang/shared": "workspace:*",
    "react": "latest",
    "react-dom": "latest",
    "@tanstack/react-router": "latest",
    "@tanstack/react-db": "latest",
    "@tanstack/react-query": "latest",
    "@elysiajs/eden": "latest",
    "better-auth": "latest"
  },
  "devDependencies": {
    "vite": "latest",
    "@vitejs/plugin-react": "latest",
    "typescript": "latest",
    "tailwindcss": "latest",
    "@tailwindcss/vite": "latest"
  }
}
```

- [ ] **Step 2: Create `apps/web/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["DOM", "DOM.Iterable", "ESNext"],
    "types": [],
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `apps/web/vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  server: { port: 5173 },
});
```

- [ ] **Step 4: Create `apps/web/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Uang</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Create `apps/web/src/index.css`**

```css
@import "tailwindcss";
```

- [ ] **Step 6: Install and verify Tailwind builds**

Run: `bun install`
Expected: installs web deps.

- [ ] **Step 7: Initialize shadcn/ui**

Run: `cd apps/web && bunx shadcn@latest init -d`
Expected: creates `components.json`, `src/lib/utils.ts`, and Tailwind theme tokens in `index.css`. Accept defaults (base color, CSS variables).

- [ ] **Step 8: Add the components used in Plan 1**

Run: `cd apps/web && bunx shadcn@latest add button input label card`
Expected: components created under `src/components/ui/`.

- [ ] **Step 9: Commit**

```bash
git add apps/web bun.lock
git commit -m "feat(web): Vite + TanStack Router deps, Tailwind v4, shadcn init"
```

---

## Task 11: Eden API client, auth client & router

**Files:**
- Create: `apps/web/src/lib/api.ts`, `apps/web/src/lib/auth.ts`, `apps/web/src/router.tsx`, `apps/web/src/main.tsx`
- Modify: `apps/api/src/index.ts` (export the app type)

- [ ] **Step 1: Export the app type for Eden from `apps/api/src/app.ts`**

Confirm `export type App = ReturnType<typeof createApp>;` exists (added in Task 7). Add a type-only export the web app can import:

Create `apps/api/src/eden.ts`:

```ts
export type { App } from "./app";
```

- [ ] **Step 2: Create `apps/web/src/lib/api.ts`**

```ts
import { treaty } from "@elysiajs/eden";
import type { App } from "../../../api/src/eden";

const url = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
export const api = treaty<App>(url, { fetch: { credentials: "include" } });
```

- [ ] **Step 3: Create `apps/web/src/lib/auth.ts`**

```ts
import { createAuthClient } from "better-auth/react";

const url = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
export const authClient = createAuthClient({ baseURL: `${url}/api/auth` });
export const { useSession, signIn, signOut } = authClient;
```

- [ ] **Step 4: Create `apps/web/src/router.tsx`**

```tsx
import { createRouter, createRoute, createRootRoute, redirect } from "@tanstack/react-router";
import { Outlet } from "@tanstack/react-router";
import { api } from "./lib/api";
import { authClient } from "./lib/auth";
import { OnboardingPage } from "./routes/onboarding";
import { LoginPage } from "./routes/login";
import { DashboardPage } from "./routes/dashboard";

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute, path: "/onboarding", component: OnboardingPage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute, path: "/login", component: LoginPage,
  beforeLoad: async () => {
    const { data } = await api.onboarding.status.get();
    if (!data?.initialized) throw redirect({ to: "/onboarding" });
  },
});

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute, path: "/", component: DashboardPage,
  beforeLoad: async () => {
    const { data } = await api.onboarding.status.get();
    if (!data?.initialized) throw redirect({ to: "/onboarding" });
    const session = await authClient.getSession();
    if (!session.data) throw redirect({ to: "/login" });
  },
});

const routeTree = rootRoute.addChildren([onboardingRoute, loginRoute, dashboardRoute]);
export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register { router: typeof router; }
}
```

- [ ] **Step 5: Create `apps/web/src/main.tsx`**

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/eden.ts apps/web/src/lib/api.ts apps/web/src/lib/auth.ts apps/web/src/router.tsx apps/web/src/main.tsx
git commit -m "feat(web): Eden client, auth client, router shell"
```

---

## Task 12: Onboarding, Login & Dashboard pages

**Files:**
- Create: `apps/web/src/routes/onboarding.tsx`, `apps/web/src/routes/login.tsx`, `apps/web/src/routes/dashboard.tsx`

- [ ] **Step 1: Create `apps/web/src/routes/onboarding.tsx`**

```tsx
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";

export function OnboardingPage() {
  const nav = useNavigate();
  const [form, setForm] = useState({ householdName: "", baseCurrency: "MYR", name: "", email: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const { error } = await api.onboarding.init.post(form);
    if (error) { setError("Could not initialize. Is it already set up?"); return; }
    await nav({ to: "/login" });
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-md p-6 space-y-4">
        <h1 className="text-xl font-semibold">Set up your household</h1>
        <form onSubmit={submit} className="space-y-3">
          <div><Label>Household name</Label><Input value={form.householdName} onChange={set("householdName")} required /></div>
          <div><Label>Base currency (ISO)</Label><Input value={form.baseCurrency} onChange={set("baseCurrency")} maxLength={3} required /></div>
          <div><Label>Your name</Label><Input value={form.name} onChange={set("name")} required /></div>
          <div><Label>Email</Label><Input type="email" value={form.email} onChange={set("email")} required /></div>
          <div><Label>Password</Label><Input type="password" value={form.password} onChange={set("password")} minLength={8} required /></div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button type="submit" className="w-full">Create household</Button>
        </form>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Create `apps/web/src/routes/login.tsx`**

```tsx
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { signIn } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";

export function LoginPage() {
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const { error } = await signIn.email({ email, password });
    if (error) { setError("Invalid email or password."); return; }
    await nav({ to: "/" });
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-sm p-6 space-y-4">
        <h1 className="text-xl font-semibold">Sign in</h1>
        <form onSubmit={submit} className="space-y-3">
          <div><Label>Email</Label><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
          <div><Label>Password</Label><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button type="submit" className="w-full">Sign in</Button>
        </form>
      </Card>
    </div>
  );
}
```

- [ ] **Step 3: Create `apps/web/src/routes/dashboard.tsx`**

```tsx
import { useNavigate } from "@tanstack/react-router";
import { useSession, signOut } from "@/lib/auth";
import { Button } from "@/components/ui/button";

export function DashboardPage() {
  const nav = useNavigate();
  const { data } = useSession();
  return (
    <div className="min-h-screen p-8 space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Uang</h1>
        <Button variant="outline" onClick={async () => { await signOut(); await nav({ to: "/login" }); }}>
          Sign out
        </Button>
      </header>
      <p className="text-muted-foreground">Signed in as {data?.user?.email}. Accounts &amp; net worth arrive in Plan 2.</p>
    </div>
  );
}
```

- [ ] **Step 4: Manual end-to-end verification**

Run (two terminals):
1. `cd apps/api && DATABASE_URL=file:./data/dev.db BETTER_AUTH_SECRET=dev WEB_ORIGIN=http://localhost:5173 bun run dev`
2. `cd apps/web && VITE_API_URL=http://localhost:3000 bun run dev`

Then in a browser at `http://localhost:5173`:
- Expected: redirected to `/onboarding`. Fill the form → redirected to `/login`.
- Sign in with the same credentials → land on the dashboard showing your email.
- Click "Sign out" → back to `/login`.
- Reload `/` while logged out → redirected to `/login` (not `/onboarding`, since it's initialized).

Then stop both servers and `rm -f apps/api/data/dev.db*`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/onboarding.tsx apps/web/src/routes/login.tsx apps/web/src/routes/dashboard.tsx
git commit -m "feat(web): onboarding, login, and dashboard placeholder pages"
```

---

## Task 13: Deployment config (Railway, two services)

**Files:**
- Create: `apps/api/Dockerfile`, `apps/web/Dockerfile`, `apps/web/nginx.conf`, `docs/DEPLOY.md`

- [ ] **Step 1: Create `apps/api/Dockerfile`**

```dockerfile
FROM oven/bun:1 AS base
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
RUN bun install --frozen-lockfile
COPY packages/shared packages/shared
COPY apps/api apps/api
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["bun", "run", "apps/api/src/index.ts"]
```

- [ ] **Step 2: Create `apps/web/nginx.conf`**

```nginx
server {
  listen 8080;
  root /usr/share/nginx/html;
  location / { try_files $uri /index.html; }
}
```

- [ ] **Step 3: Create `apps/web/Dockerfile`**

```dockerfile
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/web/package.json apps/web/package.json
RUN bun install --frozen-lockfile
COPY packages/shared packages/shared
COPY apps/web apps/web
ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL
RUN bun --cwd apps/web run build

FROM nginx:alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
```

- [ ] **Step 4: Create `docs/DEPLOY.md`**

```markdown
# Deploying Uang on Railway (two services)

## api service
- Build: Dockerfile `apps/api/Dockerfile`
- Add a **Volume** mounted at `/data`.
- Env:
  - `DATABASE_URL=file:/data/uang.db`
  - `BETTER_AUTH_SECRET=<random 32+ chars>`
  - `BETTER_AUTH_URL=https://<api-domain>`
  - `WEB_ORIGIN=https://<web-domain>`
  - `NODE_ENV=production`
- Migrations run automatically on boot.

## web service
- Build: Dockerfile `apps/web/Dockerfile`
- Build arg / env: `VITE_API_URL=https://<api-domain>`

## Cookies & CORS
better-auth sets session cookies. For cross-subdomain cookies, host both under one
parent domain (e.g. `app.example.com` + `api.example.com`) and the browser will send
credentials because the SPA uses `credentials: "include"` and the API allows
`WEB_ORIGIN` with `credentials: true`. Ensure both are HTTPS (Secure cookies).

## Backup
Use the in-app export (Plan 2) and periodic Railway volume snapshots.
```

- [ ] **Step 5: Verify the web build succeeds**

Run: `cd apps/web && VITE_API_URL=http://localhost:3000 bun run build`
Expected: `dist/` produced with no type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/Dockerfile apps/web/Dockerfile apps/web/nginx.conf docs/DEPLOY.md
git commit -m "chore: Railway deployment config for api + web"
```

---

## Task 14: Full test sweep & README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Run the entire test suite**

Run: `DATABASE_URL=file:./apps/api/data/test.db bun test`
Expected: all shared + api tests PASS. Then `rm -f apps/api/data/test.db*`.

- [ ] **Step 2: Create `README.md`**

```markdown
# Uang

Self-hosted, single-household personal finance. Monorepo: `apps/web` (SPA),
`apps/api` (ElysiaJS/Bun + libSQL/Drizzle), `packages/shared` (money core).

## Dev
1. `bun install`
2. API: `cd apps/api && DATABASE_URL=file:./data/dev.db BETTER_AUTH_SECRET=dev WEB_ORIGIN=http://localhost:5173 bun run dev`
3. Web: `cd apps/web && VITE_API_URL=http://localhost:3000 bun run dev`
4. Open http://localhost:5173 → complete first-run onboarding.

## Test
`bun test` (set `DATABASE_URL` to a disposable file for api tests).

## Deploy
See `docs/DEPLOY.md`.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: project README"
```

---

## Self-Review Notes (coverage vs spec)

- **Stack (spec §3):** Vite SPA + TanStack Router (T10–12), TanStack DB dep installed for Plan 2 (T10), Elysia/Bun + libSQL/Drizzle (T5–7), better-auth (T6, T8–9), shadcn+Tailwind (T10), Eden (T11), two-service Railway deploy (T13). ✓
- **Money model (spec §4–5):** BigInt minor units, `SCALE`, `roundDiv` banker's rounding, `convertToBase`, currency-decimals map — all unit-tested (T2–4). ✓
- **Schema (spec §4):** all tables (settings, accounts, entries, instruments, lots, prices, fx_rates + auth) created now for stable migrations (T5–6). ✓
- **Auth (spec §8):** first-run admin, settings singleton, signup gated after first user (T8–9). ✓
- **Deferred to Plan 2/3:** accounts/ledger/backfill/net-worth/export (Plan 2), holdings valuation logic (Plan 3). The schema + money core they depend on are delivered here.
- **Type consistency:** `App` type exported from `app.ts` and re-exported via `eden.ts`; `convertToBase(amountMinor, from, base, rateScaled)` signature used consistently; `isInitialized()` reused in routes and guard; `SCALE` single source in `money.ts`.
- **Placeholder scan:** no TBD/TODO; every code step has complete code; verification commands have expected output.
```
