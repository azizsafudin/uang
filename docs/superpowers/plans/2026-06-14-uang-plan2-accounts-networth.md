# Uang — Plan 2: Accounts, Balances, Backfill & Net Worth (headline)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the household create accounts (assets & liabilities) in any currency, onboard already-held balances via backfill, manage FX rates, and see total net worth rolled up to the base currency — with a real accounts dashboard.

**Architecture:** Build on the Plan 1 foundation. Add an auth-guarded API surface in the Elysia app for accounts, ledger entries (backfill via adjustment/revaluation), FX rates, net worth, an admin user-invite, and a DB export. On the web, wire a TanStack Query client + **TanStack DB query collections** (accounts, entries, fxRates) for reactive optimistic data, and build the dashboard, account detail, and settings screens with shadcn/ui.

**Tech Stack:** (unchanged from Plan 1) Bun, ElysiaJS, libSQL/Drizzle, better-auth, TanStack Router, **TanStack DB + TanStack Query**, shadcn/ui + Tailwind, Eden Treaty. Tests: `bun test`.

> **Scope:** Plan 2 of the slice. **In:** accounts CRUD, ledger entries (opening/adjustment/revaluation), backfill flows, FX-rate management, net-worth **headline** + accounts list, admin user invite, DB export, web data-layer wiring. **Deferred:** net-worth **over-time graph** (Plan 3), investment **holdings** valuation (Plan 4 — accounts created with `valuation_mode='holdings'` are out of scope here; v2 only handles `'ledger'`). Realized-gain methods, auto price/FX fetch — later.

> **Money at the JSON boundary:** the DB stores money as integer minor units (`amount_minor`, etc.). The `@uang/shared` math uses `BigInt`. At the API boundary we serialize money as JS **numbers** (safe: household sums stay well under 2^53). Convert `Number ↔ BigInt` only at the math edge. A helper `toBig`/`fromBig` is added in Task 2.

---

## File Structure

```
apps/api/src/
├── lib/
│   ├── auth-guard.ts      # Elysia plugin: resolve better-auth session -> userId/isAdmin, 401 if absent
│   ├── auth-guard.test.ts
│   ├── ids.ts             # uuid + epoch helpers (createId, nowEpoch)
│   ├── valuation.ts       # accountBalanceMinor, latestFxRateScaled, netWorth (the money engine)
│   └── valuation.test.ts
├── routes/
│   ├── accounts.ts        # GET/POST/PATCH accounts; archive
│   ├── accounts.test.ts
│   ├── entries.ts         # list/add/delete entries; set-balance & revalue (backfill)
│   ├── entries.test.ts
│   ├── fx.ts              # GET/POST/DELETE fx_rates
│   ├── fx.test.ts
│   ├── networth.ts        # GET /networth (headline + per-account breakdown)
│   ├── networth.test.ts
│   ├── users.ts           # POST /users (admin-only invite); GET /users
│   ├── users.test.ts
│   └── export.ts          # GET /export -> streams the SQLite file
├── lib/test-helpers.ts    # makeApp()/seed helpers for route tests (fresh migrated DB)
└── app.ts                 # MODIFIED: mount the new routes under the auth guard

apps/web/src/
├── lib/
│   ├── query.ts           # QueryClient singleton
│   └── collections.ts     # TanStack DB collections: accounts, entries, fxRates (query collections over Eden)
├── lib/guards.ts          # requireInitializedAndAuthed() shared route beforeLoad
├── components/
│   ├── money.ts           # formatMoney(minor, currency) display helper (Intl)
│   ├── account-form.tsx   # create/edit account dialog (shadcn)
│   ├── set-balance-dialog.tsx
│   └── revalue-dialog.tsx
├── routes/
│   ├── dashboard.tsx      # MODIFIED: net-worth headline + accounts list
│   ├── account-detail.tsx # entries list + backfill actions
│   └── settings.tsx       # FX rates, invite user, export
├── router.tsx             # MODIFIED: add /accounts/$id and /settings routes
└── main.tsx               # MODIFIED: wrap in QueryClientProvider
```

---

# PHASE A — API

## Task 1: Auth guard plugin

**Files:**
- Create: `apps/api/src/lib/auth-guard.ts`, `apps/api/src/lib/test-helpers.ts`, `apps/api/src/lib/auth-guard.test.ts`

- [ ] **Step 1: Create `apps/api/src/lib/test-helpers.ts`**

```ts
import { createApp } from "../app";
import { runMigrations } from "../db/migrate";
import { db } from "../db/client";
import { settings, user, accounts, entries, fxRates } from "../db/schema";
import { auth } from "../auth";

// Reset all app + settings tables (NOT better-auth tables unless asked) for a clean test.
export async function resetDb() {
  await runMigrations();
  await db.delete(entries);
  await db.delete(accounts);
  await db.delete(fxRates);
  await db.delete(settings);
  await db.delete(user);
}

// Initialize the household + an admin user, return a session cookie header for authed requests.
export async function initAndLogin(opts?: { baseCurrency?: string }) {
  const app = createApp();
  await app.handle(new Request("http://localhost/onboarding/init", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      householdName: "Test", baseCurrency: opts?.baseCurrency ?? "USD",
      email: "admin@test.com", name: "Admin", password: "supersecret1",
    }),
  }));
  const res = await app.handle(new Request("http://localhost/api/auth/sign-in/email", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@test.com", password: "supersecret1" }),
  }));
  const cookie = res.headers.get("set-cookie") ?? "";
  return { app, cookie };
}

export { auth };
```

- [ ] **Step 2: Write the failing test `apps/api/src/lib/auth-guard.test.ts`**

```ts
import { expect, test, beforeEach } from "bun:test";
import { Elysia } from "elysia";
import { authGuard } from "./auth-guard";
import { resetDb, initAndLogin } from "./test-helpers";

beforeEach(resetDb);

function guardedApp() {
  return new Elysia().use(authGuard).get("/whoami", ({ userId }: any) => ({ userId }));
}

test("rejects unauthenticated requests with 401", async () => {
  const app = guardedApp();
  const res = await app.handle(new Request("http://localhost/whoami"));
  expect(res.status).toBe(401);
});

test("allows authenticated requests and exposes userId", async () => {
  const { cookie } = await initAndLogin();
  const app = guardedApp();
  const res = await app.handle(new Request("http://localhost/whoami", { headers: { cookie } }));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(typeof body.userId).toBe("string");
  expect(body.userId.length).toBeGreaterThan(0);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/api && rm -f data/test.db* && DATABASE_URL=file:./data/test.db bun test src/lib/auth-guard.test.ts`
Expected: FAIL — `./auth-guard` not found.

- [ ] **Step 4: Implement `apps/api/src/lib/auth-guard.ts`**

```ts
import { Elysia } from "elysia";
import { auth } from "../auth";

// Resolves the better-auth session and exposes userId/isAdmin to handlers.
// Returns 401 for requests without a valid session.
// NOTE: verify Elysia 1.4 scoping — `.as("scoped")` propagates resolve/onBeforeHandle
// to the parent app that does `.use(authGuard)`. Adapt if the installed API differs.
export const authGuard = new Elysia({ name: "auth-guard" })
  .resolve(async ({ request }) => {
    const session = await auth.api.getSession({ headers: request.headers });
    return { userId: session?.user?.id ?? null, isAdmin: !!session?.user?.isAdmin };
  })
  .onBeforeHandle(({ userId, set }) => {
    if (!userId) {
      set.status = 401;
      return { error: "unauthorized" };
    }
  })
  .as("scoped");
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/api && rm -f data/test.db* && DATABASE_URL=file:./data/test.db bun test src/lib/auth-guard.test.ts`
Expected: PASS (2 tests). If the `.as("scoped")` propagation doesn't expose `userId` on the parent route in Elysia 1.4.28, adapt (e.g. use a `macro` or apply the guard inside each route group) until both tests pass. Then `rm -f apps/api/data/test.db*`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/auth-guard.ts apps/api/src/lib/auth-guard.test.ts apps/api/src/lib/test-helpers.ts
git commit -m "feat(api): auth guard plugin + route test helpers"
```

---

## Task 2: ID/epoch helpers + money boundary

**Files:**
- Create: `apps/api/src/lib/ids.ts`
- Modify: `packages/shared/src/money.ts`, `packages/shared/src/money.test.ts`

- [ ] **Step 1: Create `apps/api/src/lib/ids.ts`**

```ts
import { randomUUID } from "node:crypto";

export const createId = (): string => randomUUID();
export const nowEpoch = (): number => Math.floor(Date.now() / 1000);
```

- [ ] **Step 2: Add failing tests for `toBig`/`fromBig` in `packages/shared/src/money.test.ts`**

Append:

```ts
import { toBig, fromBig } from "./money";

test("toBig/fromBig round-trip integers", () => {
  expect(toBig(12345)).toBe(12345n);
  expect(fromBig(12345n)).toBe(12345);
  expect(toBig(-50)).toBe(-50n);
});

test("fromBig throws above the safe integer boundary", () => {
  expect(() => fromBig(9_007_199_254_740_993n)).toThrow();
});
```

- [ ] **Step 3: Run to verify failure**

Run: `bun test packages/shared/src/money.test.ts`
Expected: FAIL — `toBig`/`fromBig` not exported.

- [ ] **Step 4: Implement in `packages/shared/src/money.ts`** (append)

```ts
// Boundary helpers between DB/JSON numbers and BigInt math.
export function toBig(n: number): bigint {
  if (!Number.isInteger(n)) throw new Error("toBig: expected an integer");
  return BigInt(n);
}

export function fromBig(b: bigint): number {
  if (b > 9_007_199_254_740_991n || b < -9_007_199_254_740_991n) {
    throw new Error("fromBig: value exceeds safe integer range");
  }
  return Number(b);
}
```

- [ ] **Step 5: Run to verify pass**

Run: `bun test packages/shared/src/money.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/ids.ts packages/shared/src/money.ts packages/shared/src/money.test.ts
git commit -m "feat: id/epoch helpers and BigInt boundary helpers"
```

---

## Task 3: Valuation engine (balances, FX lookup, net worth)

**Files:**
- Create: `apps/api/src/lib/valuation.ts`, `apps/api/src/lib/valuation.test.ts`

- [ ] **Step 1: Write the failing test `apps/api/src/lib/valuation.test.ts`**

```ts
import { expect, test, beforeEach } from "bun:test";
import { resetDb } from "./test-helpers";
import { db } from "../db/client";
import { settings, accounts, entries, fxRates } from "../db/schema";
import { createId, nowEpoch } from "./ids";
import { accountBalanceMinor, netWorth } from "./valuation";

async function seedBase(currency: string) {
  await db.insert(settings).values({ id: 1, householdName: "H", baseCurrency: currency, createdAt: nowEpoch() });
}
async function addAccount(p: { name: string; cls: string; currency: string }) {
  const id = createId();
  await db.insert(accounts).values({
    id, name: p.name, class: p.cls, subtype: "bank", currency: p.currency,
    valuationMode: "ledger", isArchived: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy: "u",
  });
  return id;
}
async function addEntry(accountId: string, amountMinor: number, date: string, kind = "opening") {
  await db.insert(entries).values({
    id: createId(), accountId, date, amountMinor, kind, createdAt: nowEpoch(), createdBy: "u",
  });
}

beforeEach(resetDb);

test("accountBalanceMinor sums entries up to asOf inclusive", async () => {
  await seedBase("USD");
  const a = await addAccount({ name: "Checking", cls: "asset", currency: "USD" });
  await addEntry(a, 10000, "2026-01-01");
  await addEntry(a, -2500, "2026-02-01", "transaction");
  await addEntry(a, 999, "2026-03-15", "transaction");
  expect(await accountBalanceMinor(a)).toBe(8499);
  expect(await accountBalanceMinor(a, "2026-02-01")).toBe(7500);
  expect(await accountBalanceMinor(a, "2025-12-31")).toBe(0);
});

test("netWorth sums assets minus liabilities in base currency, converting FX", async () => {
  await seedBase("USD");
  const usd = await addAccount({ name: "US Checking", cls: "asset", currency: "USD" });
  await addEntry(usd, 100000, "2026-01-01"); // $1,000.00
  const cc = await addAccount({ name: "Credit Card", cls: "liability", currency: "USD" });
  await addEntry(cc, -25000, "2026-01-01"); // -$250.00
  const myr = await addAccount({ name: "MY Savings", cls: "asset", currency: "MYR" });
  await addEntry(myr, 45000, "2026-01-01"); // RM450.00
  // 1 MYR = 0.22 USD
  await db.insert(fxRates).values({ id: createId(), currency: "MYR", date: "2026-01-01", rateScaled: 22_000_000, createdAt: nowEpoch() });

  const nw = await netWorth();
  expect(nw.baseCurrency).toBe("USD");
  // 100000 - 25000 + round(45000 * 22e6 / 1e8) = 75000 + 9900 = 84900
  expect(nw.totalBaseMinor).toBe(84900);
  const my = nw.accounts.find((x) => x.name === "MY Savings")!;
  expect(my.baseMinor).toBe(9900);
  expect(my.missingRate).toBe(false);
});

test("netWorth flags accounts with no FX rate and excludes them from the total", async () => {
  await seedBase("USD");
  const eur = await addAccount({ name: "EU Account", cls: "asset", currency: "EUR" });
  await addEntry(eur, 50000, "2026-01-01");
  const nw = await netWorth();
  expect(nw.totalBaseMinor).toBe(0);
  const e = nw.accounts.find((x) => x.name === "EU Account")!;
  expect(e.missingRate).toBe(true);
  expect(e.baseMinor).toBe(0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && rm -f data/test.db* && DATABASE_URL=file:./data/test.db bun test src/lib/valuation.test.ts`
Expected: FAIL — `./valuation` not found.

- [ ] **Step 3: Implement `apps/api/src/lib/valuation.ts`**

```ts
import { db } from "../db/client";
import { accounts, entries, fxRates, settings } from "../db/schema";
import { and, eq, lte, sql, desc } from "drizzle-orm";
import { convertToBase, toBig, fromBig, SCALE } from "@uang/shared";

export async function accountBalanceMinor(accountId: string, asOf?: string): Promise<number> {
  const where = asOf
    ? and(eq(entries.accountId, accountId), lte(entries.date, asOf))
    : eq(entries.accountId, accountId);
  const rows = await db
    .select({ total: sql<number>`coalesce(sum(${entries.amountMinor}), 0)` })
    .from(entries)
    .where(where);
  return rows[0]?.total ?? 0;
}

export async function latestFxRateScaled(currency: string, asOf?: string): Promise<number | null> {
  const where = asOf
    ? and(eq(fxRates.currency, currency), lte(fxRates.date, asOf))
    : eq(fxRates.currency, currency);
  const rows = await db
    .select({ rateScaled: fxRates.rateScaled })
    .from(fxRates)
    .where(where)
    .orderBy(desc(fxRates.date))
    .limit(1);
  return rows[0]?.rateScaled ?? null;
}

export type AccountValuation = {
  id: string; name: string; class: string; subtype: string; currency: string;
  balanceMinor: number; baseMinor: number; missingRate: boolean;
};

export type NetWorth = {
  baseCurrency: string;
  totalBaseMinor: number;
  accounts: AccountValuation[];
};

export async function netWorth(asOf?: string): Promise<NetWorth> {
  const s = (await db.select().from(settings).where(eq(settings.id, 1)))[0];
  const base = s?.baseCurrency ?? "USD";
  const accts = await db.select().from(accounts).where(eq(accounts.isArchived, 0));

  let total = 0n;
  const out: AccountValuation[] = [];
  for (const a of accts) {
    const balanceMinor = await accountBalanceMinor(a.id, asOf);
    let baseMinor = 0;
    let missingRate = false;
    if (a.currency.toUpperCase() === base.toUpperCase()) {
      baseMinor = balanceMinor;
    } else {
      const rate = await latestFxRateScaled(a.currency, asOf);
      if (rate === null) {
        missingRate = true;
      } else {
        baseMinor = fromBig(convertToBase(toBig(balanceMinor), a.currency, base, toBig(rate)));
      }
    }
    if (!missingRate) total += toBig(baseMinor);
    out.push({
      id: a.id, name: a.name, class: a.class, subtype: a.subtype, currency: a.currency,
      balanceMinor, baseMinor, missingRate,
    });
  }
  return { baseCurrency: base, totalBaseMinor: fromBig(total), accounts: out };
}

export { SCALE };
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/api && rm -f data/test.db* && DATABASE_URL=file:./data/test.db bun test src/lib/valuation.test.ts`
Expected: PASS (3 tests). Then `rm -f apps/api/data/test.db*`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/valuation.ts apps/api/src/lib/valuation.test.ts
git commit -m "feat(api): valuation engine (balances, FX lookup, net worth)"
```

---

## Task 4: Accounts routes

**Files:**
- Create: `apps/api/src/routes/accounts.ts`, `apps/api/src/routes/accounts.test.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Write the failing test `apps/api/src/routes/accounts.test.ts`**

```ts
import { expect, test, beforeEach } from "bun:test";
import { resetDb, initAndLogin } from "../lib/test-helpers";

beforeEach(resetDb);

test("requires auth", async () => {
  const { app } = await initAndLogin();
  const res = await app.handle(new Request("http://localhost/accounts"));
  expect(res.status).toBe(401);
});

test("create then list accounts, with optional opening balance", async () => {
  const { app, cookie } = await initAndLogin({ baseCurrency: "USD" });
  const create = await app.handle(new Request("http://localhost/accounts", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      name: "Checking", class: "asset", subtype: "bank", currency: "USD",
      openingBalanceMinor: 100000, openingDate: "2026-01-01",
    }),
  }));
  expect(create.status).toBe(200);
  const created = await create.json();
  expect(created.id).toBeTruthy();

  const list = await app.handle(new Request("http://localhost/accounts", { headers: { cookie } }));
  const body = await list.json();
  expect(body.length).toBe(1);
  expect(body[0].name).toBe("Checking");
  expect(body[0].balanceMinor).toBe(100000); // opening entry applied
});

test("rejects holdings valuation mode in v2", async () => {
  const { app, cookie } = await initAndLogin();
  const res = await app.handle(new Request("http://localhost/accounts", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Broker", class: "asset", subtype: "investment", currency: "USD", valuationMode: "holdings" }),
  }));
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && rm -f data/test.db* && DATABASE_URL=file:./data/test.db bun test src/routes/accounts.test.ts`
Expected: FAIL — route not mounted (401/404 mismatch or import error).

- [ ] **Step 3: Implement `apps/api/src/routes/accounts.ts`**

```ts
import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { accounts, entries } from "../db/schema";
import { eq } from "drizzle-orm";
import { authGuard } from "../lib/auth-guard";
import { createId, nowEpoch } from "../lib/ids";
import { accountBalanceMinor } from "../lib/valuation";

export const accountsRoutes = new Elysia({ prefix: "/accounts" })
  .use(authGuard)
  .get("/", async () => {
    const rows = await db.select().from(accounts).orderBy(accounts.sortOrder);
    return Promise.all(rows.map(async (a) => ({ ...a, balanceMinor: await accountBalanceMinor(a.id) })));
  })
  .post(
    "/",
    async ({ body, userId, set }) => {
      if ((body.valuationMode ?? "ledger") !== "ledger") {
        set.status = 400;
        return { error: "holdings_not_supported_in_v2" };
      }
      const id = createId();
      await db.insert(accounts).values({
        id, name: body.name, class: body.class, subtype: body.subtype,
        currency: body.currency.toUpperCase(), valuationMode: "ledger",
        institution: body.institution ?? null, isArchived: 0, sortOrder: body.sortOrder ?? 0,
        createdAt: nowEpoch(), createdBy: userId!,
      });
      if (typeof body.openingBalanceMinor === "number" && body.openingBalanceMinor !== 0) {
        await db.insert(entries).values({
          id: createId(), accountId: id, date: body.openingDate ?? new Date(nowEpoch() * 1000).toISOString().slice(0, 10),
          amountMinor: body.openingBalanceMinor, kind: "opening",
          createdAt: nowEpoch(), createdBy: userId!,
        });
      }
      return { id };
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1 }),
        class: t.Union([t.Literal("asset"), t.Literal("liability")]),
        subtype: t.String({ minLength: 1 }),
        currency: t.String({ pattern: "^[A-Za-z]{3}$" }),
        valuationMode: t.Optional(t.String()),
        institution: t.Optional(t.String()),
        sortOrder: t.Optional(t.Number()),
        openingBalanceMinor: t.Optional(t.Number()),
        openingDate: t.Optional(t.String()),
      }),
    },
  )
  .patch(
    "/:id",
    async ({ params, body }) => {
      await db.update(accounts).set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.institution !== undefined ? { institution: body.institution } : {}),
        ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
        ...(body.isArchived !== undefined ? { isArchived: body.isArchived ? 1 : 0 } : {}),
      }).where(eq(accounts.id, params.id));
      return { ok: true };
    },
    {
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1 })),
        institution: t.Optional(t.String()),
        sortOrder: t.Optional(t.Number()),
        isArchived: t.Optional(t.Boolean()),
      }),
    },
  );
```

- [ ] **Step 4: Mount it in `apps/api/src/app.ts`**

Add the import and `.use(accountsRoutes)` after `.use(onboarding)` and before the better-auth `.all(...)`:

```ts
import { accountsRoutes } from "./routes/accounts";
// ... .use(onboarding)
//     .use(accountsRoutes)
```

- [ ] **Step 5: Run to verify pass**

Run: `cd apps/api && rm -f data/test.db* && DATABASE_URL=file:./data/test.db bun test src/routes/accounts.test.ts`
Expected: PASS (3 tests). Then `rm -f apps/api/data/test.db*`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/accounts.ts apps/api/src/routes/accounts.test.ts apps/api/src/app.ts
git commit -m "feat(api): accounts CRUD with opening balance"
```

---

## Task 5: Entries & backfill routes (set-balance, revalue)

**Files:**
- Create: `apps/api/src/routes/entries.ts`, `apps/api/src/routes/entries.test.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Write the failing test `apps/api/src/routes/entries.test.ts`**

```ts
import { expect, test, beforeEach } from "bun:test";
import { resetDb, initAndLogin } from "../lib/test-helpers";

beforeEach(resetDb);

async function makeAccount(app: any, cookie: string, currency = "USD") {
  const res = await app.handle(new Request("http://localhost/accounts", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Acct", class: "asset", subtype: "bank", currency }),
  }));
  return (await res.json()).id as string;
}

test("set-balance inserts an adjustment equal to the delta", async () => {
  const { app, cookie } = await initAndLogin();
  const id = await makeAccount(app, cookie);
  // no entries yet -> balance 0; set to 123456 on a date
  const res = await app.handle(new Request(`http://localhost/accounts/${id}/set-balance`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ targetMinor: 123456, date: "2026-02-01" }),
  }));
  expect(res.status).toBe(200);
  // list accounts -> balance now equals target
  const list = await (await app.handle(new Request("http://localhost/accounts", { headers: { cookie } }))).json();
  expect(list[0].balanceMinor).toBe(123456);

  // set again to a lower number -> a second adjustment brings it exactly there
  await app.handle(new Request(`http://localhost/accounts/${id}/set-balance`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ targetMinor: 100000, date: "2026-03-01" }),
  }));
  const list2 = await (await app.handle(new Request("http://localhost/accounts", { headers: { cookie } }))).json();
  expect(list2[0].balanceMinor).toBe(100000);
});

test("entries can be listed and deleted", async () => {
  const { app, cookie } = await initAndLogin();
  const id = await makeAccount(app, cookie);
  await app.handle(new Request(`http://localhost/accounts/${id}/set-balance`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ targetMinor: 5000, date: "2026-01-01" }),
  }));
  const entries = await (await app.handle(new Request(`http://localhost/accounts/${id}/entries`, { headers: { cookie } }))).json();
  expect(entries.length).toBe(1);
  const del = await app.handle(new Request(`http://localhost/entries/${entries[0].id}`, { method: "DELETE", headers: { cookie } }));
  expect(del.status).toBe(200);
  const after = await (await app.handle(new Request(`http://localhost/accounts/${id}/entries`, { headers: { cookie } }))).json();
  expect(after.length).toBe(0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && rm -f data/test.db* && DATABASE_URL=file:./data/test.db bun test src/routes/entries.test.ts`
Expected: FAIL — routes not mounted.

- [ ] **Step 3: Implement `apps/api/src/routes/entries.ts`**

```ts
import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { entries } from "../db/schema";
import { eq } from "drizzle-orm";
import { authGuard } from "../lib/auth-guard";
import { createId, nowEpoch } from "../lib/ids";
import { accountBalanceMinor } from "../lib/valuation";

// Shared mechanic: insert a delta entry so the account's balance AT `date` equals `targetMinor`.
async function applyTarget(accountId: string, targetMinor: number, date: string, kind: "adjustment" | "revaluation", userId: string) {
  const current = await accountBalanceMinor(accountId, date);
  const delta = targetMinor - current;
  await db.insert(entries).values({
    id: createId(), accountId, date, amountMinor: delta, kind,
    createdAt: nowEpoch(), createdBy: userId,
  });
}

export const entriesRoutes = new Elysia()
  .use(authGuard)
  .get("/accounts/:id/entries", async ({ params }) => {
    return db.select().from(entries).where(eq(entries.accountId, params.id)).orderBy(entries.date);
  })
  .post(
    "/accounts/:id/set-balance",
    async ({ params, body, userId }) => {
      await applyTarget(params.id, body.targetMinor, body.date, "adjustment", userId!);
      return { ok: true };
    },
    { body: t.Object({ targetMinor: t.Number(), date: t.String() }) },
  )
  .post(
    "/accounts/:id/revalue",
    async ({ params, body, userId }) => {
      await applyTarget(params.id, body.newValueMinor, body.date, "revaluation", userId!);
      return { ok: true };
    },
    { body: t.Object({ newValueMinor: t.Number(), date: t.String() }) },
  )
  .post(
    "/accounts/:id/entries",
    async ({ params, body, userId }) => {
      const id = createId();
      await db.insert(entries).values({
        id, accountId: params.id, date: body.date, amountMinor: body.amountMinor,
        kind: body.kind ?? "transaction", note: body.note ?? null,
        createdAt: nowEpoch(), createdBy: userId!,
      });
      return { id };
    },
    { body: t.Object({ amountMinor: t.Number(), date: t.String(), kind: t.Optional(t.String()), note: t.Optional(t.String()) }) },
  )
  .delete("/entries/:id", async ({ params }) => {
    await db.delete(entries).where(eq(entries.id, params.id));
    return { ok: true };
  });
```

- [ ] **Step 4: Mount in `apps/api/src/app.ts`** — add `import { entriesRoutes }` and `.use(entriesRoutes)` next to `accountsRoutes`.

- [ ] **Step 5: Run to verify pass**

Run: `cd apps/api && rm -f data/test.db* && DATABASE_URL=file:./data/test.db bun test src/routes/entries.test.ts`
Expected: PASS (2 tests). Then `rm -f apps/api/data/test.db*`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/entries.ts apps/api/src/routes/entries.test.ts apps/api/src/app.ts
git commit -m "feat(api): entries + backfill (set-balance, revalue)"
```

---

## Task 6: FX-rate routes

**Files:**
- Create: `apps/api/src/routes/fx.ts`, `apps/api/src/routes/fx.test.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Write the failing test `apps/api/src/routes/fx.test.ts`**

```ts
import { expect, test, beforeEach } from "bun:test";
import { resetDb, initAndLogin } from "../lib/test-helpers";

beforeEach(resetDb);

test("create, list, and replace (upsert) an fx rate per currency+date", async () => {
  const { app, cookie } = await initAndLogin({ baseCurrency: "USD" });
  const post = (body: any) => app.handle(new Request("http://localhost/fx", {
    method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body),
  }));

  expect((await post({ currency: "MYR", date: "2026-01-01", rateScaled: 22_000_000 })).status).toBe(200);
  // same currency+date again -> upsert, not a duplicate (unique index)
  expect((await post({ currency: "MYR", date: "2026-01-01", rateScaled: 23_000_000 })).status).toBe(200);

  const list = await (await app.handle(new Request("http://localhost/fx", { headers: { cookie } }))).json();
  const myr = list.filter((r: any) => r.currency === "MYR");
  expect(myr.length).toBe(1);
  expect(myr[0].rateScaled).toBe(23_000_000);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && rm -f data/test.db* && DATABASE_URL=file:./data/test.db bun test src/routes/fx.test.ts`
Expected: FAIL — route not mounted.

- [ ] **Step 3: Implement `apps/api/src/routes/fx.ts`**

```ts
import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { fxRates } from "../db/schema";
import { and, eq } from "drizzle-orm";
import { authGuard } from "../lib/auth-guard";
import { createId, nowEpoch } from "../lib/ids";

export const fxRoutes = new Elysia({ prefix: "/fx" })
  .use(authGuard)
  .get("/", async () => db.select().from(fxRates).orderBy(fxRates.currency, fxRates.date))
  .post(
    "/",
    async ({ body }) => {
      const currency = body.currency.toUpperCase();
      // Upsert by (currency, date): delete any existing then insert (the unique index guarantees one).
      await db.delete(fxRates).where(and(eq(fxRates.currency, currency), eq(fxRates.date, body.date)));
      const id = createId();
      await db.insert(fxRates).values({ id, currency, date: body.date, rateScaled: body.rateScaled, createdAt: nowEpoch() });
      return { id };
    },
    { body: t.Object({ currency: t.String({ pattern: "^[A-Za-z]{3}$" }), date: t.String(), rateScaled: t.Number() }) },
  )
  .delete("/:id", async ({ params }) => {
    await db.delete(fxRates).where(eq(fxRates.id, params.id));
    return { ok: true };
  });
```

- [ ] **Step 4: Mount in `apps/api/src/app.ts`** — `import { fxRoutes }` + `.use(fxRoutes)`.

- [ ] **Step 5: Run to verify pass**

Run: `cd apps/api && rm -f data/test.db* && DATABASE_URL=file:./data/test.db bun test src/routes/fx.test.ts`
Expected: PASS. Then `rm -f apps/api/data/test.db*`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/fx.ts apps/api/src/routes/fx.test.ts apps/api/src/app.ts
git commit -m "feat(api): FX-rate management (upsert per currency+date)"
```

---

## Task 7: Net-worth route

**Files:**
- Create: `apps/api/src/routes/networth.ts`, `apps/api/src/routes/networth.test.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Write the failing test `apps/api/src/routes/networth.test.ts`**

```ts
import { expect, test, beforeEach } from "bun:test";
import { resetDb, initAndLogin } from "../lib/test-helpers";

beforeEach(resetDb);

test("GET /networth returns the headline and per-account breakdown", async () => {
  const { app, cookie } = await initAndLogin({ baseCurrency: "USD" });
  const mk = (b: any) => app.handle(new Request("http://localhost/accounts", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(b) }));
  await mk({ name: "Checking", class: "asset", subtype: "bank", currency: "USD", openingBalanceMinor: 100000, openingDate: "2026-01-01" });
  await mk({ name: "Card", class: "liability", subtype: "credit_card", currency: "USD", openingBalanceMinor: -25000, openingDate: "2026-01-01" });

  const res = await app.handle(new Request("http://localhost/networth", { headers: { cookie } }));
  expect(res.status).toBe(200);
  const nw = await res.json();
  expect(nw.baseCurrency).toBe("USD");
  expect(nw.totalBaseMinor).toBe(75000);
  expect(nw.accounts.length).toBe(2);
});

test("GET /networth requires auth", async () => {
  const { app } = await initAndLogin();
  expect((await app.handle(new Request("http://localhost/networth"))).status).toBe(401);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && rm -f data/test.db* && DATABASE_URL=file:./data/test.db bun test src/routes/networth.test.ts`
Expected: FAIL — route not mounted.

- [ ] **Step 3: Implement `apps/api/src/routes/networth.ts`**

```ts
import { Elysia, t } from "elysia";
import { authGuard } from "../lib/auth-guard";
import { netWorth } from "../lib/valuation";

export const networthRoutes = new Elysia()
  .use(authGuard)
  .get("/networth", async ({ query }) => netWorth(query.asOf), {
    query: t.Object({ asOf: t.Optional(t.String()) }),
  });
```

- [ ] **Step 4: Mount in `apps/api/src/app.ts`** — `import { networthRoutes }` + `.use(networthRoutes)`.

- [ ] **Step 5: Run to verify pass**

Run: `cd apps/api && rm -f data/test.db* && DATABASE_URL=file:./data/test.db bun test src/routes/networth.test.ts`
Expected: PASS. Then `rm -f apps/api/data/test.db*`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/networth.ts apps/api/src/routes/networth.test.ts apps/api/src/app.ts
git commit -m "feat(api): net-worth endpoint"
```

---

## Task 8: Admin user-invite + export routes

**Files:**
- Create: `apps/api/src/routes/users.ts`, `apps/api/src/routes/users.test.ts`, `apps/api/src/routes/export.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Write the failing test `apps/api/src/routes/users.test.ts`**

```ts
import { expect, test, beforeEach } from "bun:test";
import { resetDb, initAndLogin } from "../lib/test-helpers";

beforeEach(resetDb);

test("admin can invite a user; the new user is not admin and can sign in", async () => {
  const { app, cookie } = await initAndLogin();
  const res = await app.handle(new Request("http://localhost/users", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ email: "member@test.com", name: "Member", password: "anothersecret1" }),
  }));
  expect(res.status).toBe(200);

  const list = await (await app.handle(new Request("http://localhost/users", { headers: { cookie } }))).json();
  expect(list.find((u: any) => u.email === "member@test.com")).toBeTruthy();
  expect(list.find((u: any) => u.email === "member@test.com").isAdmin).toBe(false);

  const signin = await app.handle(new Request("http://localhost/api/auth/sign-in/email", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "member@test.com", password: "anothersecret1" }),
  }));
  expect(signin.status).toBe(200);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && rm -f data/test.db* && DATABASE_URL=file:./data/test.db bun test src/routes/users.test.ts`
Expected: FAIL — route not mounted.

- [ ] **Step 3: Implement `apps/api/src/routes/users.ts`**

```ts
import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { user } from "../db/schema";
import { authGuard } from "../lib/auth-guard";
import { auth } from "../auth";

export const usersRoutes = new Elysia({ prefix: "/users" })
  .use(authGuard)
  .get("/", async () => {
    const rows = await db.select().from(user);
    return rows.map((u) => ({ id: u.id, email: u.email, name: u.name, isAdmin: !!u.isAdmin }));
  })
  .post(
    "/",
    async ({ body, isAdmin, set }) => {
      if (!isAdmin) { set.status = 403; return { error: "admin_only" }; }
      try {
        await auth.api.signUpEmail({
          body: { email: body.email, name: body.name, password: body.password },
          headers: new Headers(),
        });
      } catch {
        set.status = 422; return { error: "create_failed" };
      }
      return { ok: true };
    },
    { body: t.Object({ email: t.String({ pattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$" }), name: t.String({ minLength: 1 }), password: t.String({ minLength: 8 }) }) },
  );
```

> The signup guard in `app.ts` blocks the PUBLIC `/api/auth/sign-up/email` route post-init, but `auth.api.signUpEmail` (server-side call) bypasses HTTP and is reached only through this admin-gated route — so admin invites still work.

- [ ] **Step 4: Implement `apps/api/src/routes/export.ts`**

```ts
import { Elysia } from "elysia";
import { authGuard } from "../lib/auth-guard";
import { sqlite } from "../db/client";

export const exportRoutes = new Elysia()
  .use(authGuard)
  .get("/export", async () => {
    // Checkpoint WAL so the file on disk is consistent, then read the DB file bytes.
    try { await sqlite.execute("PRAGMA wal_checkpoint(TRUNCATE);"); } catch { /* non-fatal */ }
    const url = process.env.DATABASE_URL ?? "file:./data/uang.db";
    const path = url.replace(/^file:/, "");
    const file = Bun.file(path);
    const today = new Date().toISOString().slice(0, 10);
    return new Response(file, {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="uang-${today}.db"`,
      },
    });
  });
```

- [ ] **Step 5: Mount both in `apps/api/src/app.ts`** — `import { usersRoutes }`, `import { exportRoutes }`, then `.use(usersRoutes).use(exportRoutes)`.

- [ ] **Step 6: Run to verify pass**

Run: `cd apps/api && rm -f data/test.db* && DATABASE_URL=file:./data/test.db bun test src/routes/users.test.ts`
Expected: PASS. Then `rm -f apps/api/data/test.db*`.

- [ ] **Step 7: Full API sweep + commit**

Run: `cd apps/api && rm -f data/sweep.db* && DATABASE_URL=file:./data/sweep.db bun test && rm -f data/sweep.db*`
Expected: all API tests pass.

```bash
git add apps/api/src/routes/users.ts apps/api/src/routes/users.test.ts apps/api/src/routes/export.ts apps/api/src/app.ts
git commit -m "feat(api): admin user invite + SQLite export"
```

---

# PHASE B — WEB

## Task 9: Query client + TanStack DB collections

**Files:**
- Create: `apps/web/src/lib/query.ts`, `apps/web/src/lib/collections.ts`
- Modify: `apps/web/src/main.tsx`
- May install: `@tanstack/query-db-collection` (the query-collection adapter for TanStack DB) if not already present.

- [ ] **Step 1: Ensure the query-collection adapter is installed**

Run: `cd apps/web && bun add @tanstack/query-db-collection`
Expected: installs (TanStack DB's query collection factory `queryCollectionOptions` lives here). If the installed `@tanstack/react-db` already re-exports `queryCollectionOptions`, you may skip this — verify which package exports it and import accordingly.

- [ ] **Step 2: Create `apps/web/src/lib/query.ts`**

```ts
import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false } },
});
```

- [ ] **Step 3: Create `apps/web/src/lib/collections.ts`**

```ts
import { createCollection } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { queryClient } from "./query";
import { api } from "./api";

// Accounts collection — reads via GET /accounts, writes via the API.
// (Verify the exact queryCollectionOptions shape against the installed version and adapt.)
export const accountsCollection = createCollection(
  queryCollectionOptions({
    queryKey: ["accounts"],
    queryClient,
    queryFn: async () => {
      const { data, error } = await api.accounts.get();
      if (error) throw error;
      return data ?? [];
    },
    getKey: (a: any) => a.id,
    onInsert: async ({ transaction }) => {
      const m = transaction.mutations[0].modified as any;
      await api.accounts.post(m);
    },
    onUpdate: async ({ transaction }) => {
      const m = transaction.mutations[0].modified as any;
      await api.accounts({ id: m.id }).patch(m);
    },
  }),
);

// FX rates collection.
export const fxCollection = createCollection(
  queryCollectionOptions({
    queryKey: ["fx"],
    queryClient,
    queryFn: async () => {
      const { data, error } = await api.fx.get();
      if (error) throw error;
      return data ?? [];
    },
    getKey: (r: any) => r.id,
    onInsert: async ({ transaction }) => {
      await api.fx.post(transaction.mutations[0].modified as any);
    },
    onDelete: async ({ transaction }) => {
      const id = (transaction.mutations[0].original as any).id;
      await api.fx({ id }).delete();
    },
  }),
);
```

- [ ] **Step 4: Wrap the app in `QueryClientProvider` in `apps/web/src/main.tsx`**

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/query";
import { router } from "./router";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
```

- [ ] **Step 5: Verify the build compiles**

Run: `cd apps/web && VITE_API_URL=http://localhost:3000 bun run build`
Expected: build succeeds. If the `queryCollectionOptions` API differs from the sketch (handler arg shape, mutation access), adapt until it type-checks. The acceptance bar is a clean build; collection behavior is verified in Task 10's manual E2E.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/query.ts apps/web/src/lib/collections.ts apps/web/src/main.tsx apps/web/package.json bun.lock
git commit -m "feat(web): query client + TanStack DB collections (accounts, fx)"
```

---

## Task 10: Money format helper + Dashboard (net-worth headline + accounts list)

**Files:**
- Create: `apps/web/src/components/money.ts`
- Modify: `apps/web/src/routes/dashboard.tsx`
- Use shadcn components: ensure `card`, `button` exist (from Plan 1). Add any missing via `bunx shadcn@latest add <name>`.

- [ ] **Step 1: Create `apps/web/src/components/money.ts`**

```ts
import { currencyDecimals } from "@uang/shared";

// Format integer minor units as a localized currency string.
export function formatMoney(minor: number, currency: string): string {
  const dec = currencyDecimals(currency);
  const major = minor / 10 ** dec;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, minimumFractionDigits: dec, maximumFractionDigits: dec }).format(major);
  } catch {
    return `${major.toFixed(dec)} ${currency}`;
  }
}
```

- [ ] **Step 2: Replace `apps/web/src/routes/dashboard.tsx`**

```tsx
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { signOut } from "@/lib/auth";
import { api } from "@/lib/api";
import { formatMoney } from "@/components/money";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

type Nw = Awaited<ReturnType<typeof fetchNw>>;
async function fetchNw() {
  const { data, error } = await api.networth.get({ query: {} });
  if (error) throw error;
  return data!;
}

export function DashboardPage() {
  const nav = useNavigate();
  const { data, isLoading } = useQuery({ queryKey: ["networth"], queryFn: fetchNw });

  const grouped = (cls: string) => (data?.accounts ?? []).filter((a) => a.class === cls);

  return (
    <div className="min-h-screen p-6 md:p-8 max-w-3xl mx-auto space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Uang</h1>
        <div className="flex gap-2">
          <Link to="/settings"><Button variant="outline">Settings</Button></Link>
          <Button variant="outline" onClick={async () => { await signOut(); await nav({ to: "/login" }); }}>Sign out</Button>
        </div>
      </header>

      <Card className="p-6">
        <p className="text-sm text-muted-foreground">Net worth</p>
        <p className="text-4xl font-semibold tabular-nums">
          {isLoading || !data ? "—" : formatMoney(data.totalBaseMinor, data.baseCurrency)}
        </p>
      </Card>

      {(["asset", "liability"] as const).map((cls) => (
        <section key={cls} className="space-y-2">
          <h2 className="text-sm font-medium uppercase text-muted-foreground">{cls === "asset" ? "Assets" : "Liabilities"}</h2>
          <div className="space-y-2">
            {grouped(cls).map((a) => (
              <Link key={a.id} to="/accounts/$id" params={{ id: a.id }}>
                <Card className="p-4 flex items-center justify-between hover:bg-accent">
                  <div>
                    <p className="font-medium">{a.name}</p>
                    <p className="text-xs text-muted-foreground">{a.subtype} · {a.currency}{a.missingRate ? " · ⚠ no FX rate" : ""}</p>
                  </div>
                  <div className="text-right tabular-nums">
                    <p className="font-medium">{formatMoney(a.balanceMinor, a.currency)}</p>
                    {a.currency !== data?.baseCurrency && !a.missingRate && (
                      <p className="text-xs text-muted-foreground">{formatMoney(a.baseMinor, data!.baseCurrency)}</p>
                    )}
                  </div>
                </Card>
              </Link>
            ))}
            {grouped(cls).length === 0 && <p className="text-sm text-muted-foreground">None yet.</p>}
          </div>
        </section>
      ))}

      <AddAccountButton />
    </div>
  );
}

import { AccountForm } from "@/components/account-form";
function AddAccountButton() {
  return <AccountForm />;
}
```

> `AccountForm` is built in Task 11; it renders its own trigger button. This import keeps the dashboard complete once Task 11 lands. If you implement Task 11 first, the import resolves immediately.

- [ ] **Step 3: Verify the build (after Task 11 exists) / interim type-check**

If building before Task 11: temporarily stub `@/components/account-form` is NOT allowed (no placeholders). Implement Task 11 in the same working session before the final build, OR reorder to do Task 11 first. The committed state after Task 11 must `bun run build` clean.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/money.ts apps/web/src/routes/dashboard.tsx
git commit -m "feat(web): dashboard with net-worth headline and accounts list"
```

---

## Task 11: Account create/edit form (shadcn dialog)

**Files:**
- Create: `apps/web/src/components/account-form.tsx`
- Use shadcn: add the components this needs via the CLI.

- [ ] **Step 1: Add the shadcn components**

Run: `cd apps/web && bunx shadcn@latest add dialog select`
Expected: `src/components/ui/dialog.tsx` and `select.tsx` created.

- [ ] **Step 2: Create `apps/web/src/components/account-form.tsx`**

```tsx
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

const SUBTYPES = ["cash", "bank", "investment", "property", "loan", "credit_card", "other"];

export function AccountForm() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({
    name: "", class: "asset", subtype: "bank", currency: "USD",
    openingBalance: "", openingDate: new Date().toISOString().slice(0, 10),
  });
  const set = (k: string, v: string) => setF({ ...f, [k]: v });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const openingMajor = parseFloat(f.openingBalance);
    const body: any = { name: f.name, class: f.class, subtype: f.subtype, currency: f.currency.toUpperCase() };
    if (!Number.isNaN(openingMajor) && openingMajor !== 0) {
      // currency decimals applied client-side via a round-trip-safe integer conversion
      const dec = (await import("@uang/shared")).currencyDecimals(body.currency);
      body.openingBalanceMinor = Math.round(openingMajor * 10 ** dec);
      body.openingDate = f.openingDate;
    }
    await api.accounts.post(body);
    await qc.invalidateQueries({ queryKey: ["accounts"] });
    await qc.invalidateQueries({ queryKey: ["networth"] });
    setOpen(false);
    setF({ ...f, name: "", openingBalance: "" });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button>Add account</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>New account</DialogTitle></DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div><Label>Name</Label><Input value={f.name} onChange={(e) => set("name", e.target.value)} required /></div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Type</Label>
              <Select value={f.class} onValueChange={(v) => set("class", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="asset">Asset</SelectItem><SelectItem value="liability">Liability</SelectItem></SelectContent>
              </Select>
            </div>
            <div>
              <Label>Category</Label>
              <Select value={f.subtype} onValueChange={(v) => set("subtype", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{SUBTYPES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Currency</Label><Input value={f.currency} maxLength={3} onChange={(e) => set("currency", e.target.value)} required /></div>
            <div><Label>Opening balance</Label><Input type="number" step="any" value={f.openingBalance} onChange={(e) => set("openingBalance", e.target.value)} placeholder="optional" /></div>
          </div>
          <div><Label>Opening date</Label><Input type="date" value={f.openingDate} onChange={(e) => set("openingDate", e.target.value)} /></div>
          <DialogFooter><Button type="submit">Create</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 3: Build to verify**

Run: `cd apps/web && VITE_API_URL=http://localhost:3000 bun run build`
Expected: clean build (dashboard + form compile together).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/account-form.tsx apps/web/src/components/ui
git commit -m "feat(web): add-account dialog (shadcn)"
```

---

## Task 12: Account detail page (entries + backfill actions) + routes

**Files:**
- Create: `apps/web/src/routes/account-detail.tsx`, `apps/web/src/components/set-balance-dialog.tsx`, `apps/web/src/lib/guards.ts`
- Modify: `apps/web/src/router.tsx`

- [ ] **Step 1: Create `apps/web/src/lib/guards.ts`**

```ts
import { redirect } from "@tanstack/react-router";
import { api } from "./api";
import { authClient } from "./auth";

// Shared beforeLoad: require an initialized household + an authenticated session.
export async function requireInitializedAndAuthed() {
  const { data } = await api.onboarding.status.get();
  if (!data?.initialized) throw redirect({ to: "/onboarding" });
  const session = await authClient.getSession();
  if (!session.data) throw redirect({ to: "/login" });
}
```

- [ ] **Step 2: Create `apps/web/src/components/set-balance-dialog.tsx`**

```tsx
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { currencyDecimals } from "@uang/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";

export function SetBalanceDialog(props: { accountId: string; currency: string; mode: "set" | "revalue"; onDone: () => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const major = parseFloat(amount);
    if (Number.isNaN(major)) return;
    const minor = Math.round(major * 10 ** currencyDecimals(props.currency));
    if (props.mode === "set") {
      await api.accounts({ id: props.accountId })["set-balance"].post({ targetMinor: minor, date });
    } else {
      await api.accounts({ id: props.accountId }).revalue.post({ newValueMinor: minor, date });
    }
    await qc.invalidateQueries();
    setOpen(false); setAmount(""); props.onDone();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button variant={props.mode === "set" ? "default" : "outline"}>{props.mode === "set" ? "Set balance…" : "Record revaluation…"}</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>{props.mode === "set" ? "Set current balance" : "Record revaluation"}</DialogTitle></DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div><Label>{props.mode === "set" ? "Balance" : "New value"} ({props.currency})</Label><Input type="number" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} required /></div>
          <div><Label>As of date</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></div>
          <DialogFooter><Button type="submit">Save</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 3: Create `apps/web/src/routes/account-detail.tsx`**

```tsx
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { api } from "@/lib/api";
import { formatMoney } from "@/components/money";
import { SetBalanceDialog } from "@/components/set-balance-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export function AccountDetailPage() {
  const { id } = useParams({ from: "/accounts/$id" });
  const qc = useQueryClient();

  const accountsQ = useQuery({
    queryKey: ["accounts"],
    queryFn: async () => { const { data, error } = await api.accounts.get(); if (error) throw error; return data!; },
  });
  const entriesQ = useQuery({
    queryKey: ["entries", id],
    queryFn: async () => { const { data, error } = await api.accounts({ id }).entries.get(); if (error) throw error; return data!; },
  });

  const account = accountsQ.data?.find((a) => a.id === id);
  if (!account) return <div className="p-8"><Link to="/"><Button variant="outline">← Back</Button></Link><p className="mt-4">Account not found.</p></div>;

  async function delEntry(entryId: string) {
    await api.entries({ id: entryId }).delete();
    await qc.invalidateQueries();
  }

  return (
    <div className="min-h-screen p-6 md:p-8 max-w-2xl mx-auto space-y-5">
      <Link to="/"><Button variant="outline">← Back</Button></Link>
      <div>
        <h1 className="text-2xl font-semibold">{account.name}</h1>
        <p className="text-muted-foreground">{account.subtype} · {account.currency}</p>
        <p className="text-3xl font-semibold tabular-nums mt-2">{formatMoney(account.balanceMinor, account.currency)}</p>
      </div>
      <div className="flex gap-2">
        <SetBalanceDialog accountId={id} currency={account.currency} mode="set" onDone={() => {}} />
        <SetBalanceDialog accountId={id} currency={account.currency} mode="revalue" onDone={() => {}} />
      </div>
      <section className="space-y-2">
        <h2 className="text-sm font-medium uppercase text-muted-foreground">Entries</h2>
        {(entriesQ.data ?? []).map((e) => (
          <Card key={e.id} className="p-3 flex items-center justify-between">
            <div>
              <p className="tabular-nums">{formatMoney(e.amountMinor, account.currency)}</p>
              <p className="text-xs text-muted-foreground">{e.date} · {e.kind}{e.note ? ` · ${e.note}` : ""}</p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => delEntry(e.id)}>Delete</Button>
          </Card>
        ))}
        {(entriesQ.data ?? []).length === 0 && <p className="text-sm text-muted-foreground">No entries yet.</p>}
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Add routes in `apps/web/src/router.tsx`**

Refactor the existing `beforeLoad` of `/` to use the shared guard, and add `/accounts/$id` and `/settings`:

```tsx
import { createRouter, createRoute, createRootRoute, redirect, Outlet } from "@tanstack/react-router";
import { api } from "./lib/api";
import { requireInitializedAndAuthed } from "./lib/guards";
import { OnboardingPage } from "./routes/onboarding";
import { LoginPage } from "./routes/login";
import { DashboardPage } from "./routes/dashboard";
import { AccountDetailPage } from "./routes/account-detail";
import { SettingsPage } from "./routes/settings";

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const onboardingRoute = createRoute({ getParentRoute: () => rootRoute, path: "/onboarding", component: OnboardingPage });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute, path: "/login", component: LoginPage,
  beforeLoad: async () => { const { data } = await api.onboarding.status.get(); if (!data?.initialized) throw redirect({ to: "/onboarding" }); },
});

const dashboardRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: DashboardPage, beforeLoad: requireInitializedAndAuthed });
const accountDetailRoute = createRoute({ getParentRoute: () => rootRoute, path: "/accounts/$id", component: AccountDetailPage, beforeLoad: requireInitializedAndAuthed });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage, beforeLoad: requireInitializedAndAuthed });

const routeTree = rootRoute.addChildren([onboardingRoute, loginRoute, dashboardRoute, accountDetailRoute, settingsRoute]);
export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" { interface Register { router: typeof router; } }
```

> `SettingsPage` is created in Task 13. Implement Task 13 in the same session before the final build so the import resolves (no placeholders).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/account-detail.tsx apps/web/src/components/set-balance-dialog.tsx apps/web/src/lib/guards.ts apps/web/src/router.tsx
git commit -m "feat(web): account detail + backfill dialogs + routes"
```

---

## Task 13: Settings page (FX rates, invite user, export) + final verification

**Files:**
- Create: `apps/web/src/routes/settings.tsx`

- [ ] **Step 1: Create `apps/web/src/routes/settings.tsx`**

```tsx
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "@/lib/api";
import { SCALE } from "@uang/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export function SettingsPage() {
  const qc = useQueryClient();
  const fxQ = useQuery({ queryKey: ["fx"], queryFn: async () => { const { data, error } = await api.fx.get(); if (error) throw error; return data!; } });
  const usersQ = useQuery({ queryKey: ["users"], queryFn: async () => { const { data, error } = await api.users.get(); if (error) throw error; return data!; } });

  const [fx, setFx] = useState({ currency: "", date: new Date().toISOString().slice(0, 10), rate: "" });
  const [invite, setInvite] = useState({ email: "", name: "", password: "" });

  async function addFx(e: React.FormEvent) {
    e.preventDefault();
    const rate = parseFloat(fx.rate);
    if (Number.isNaN(rate)) return;
    await api.fx.post({ currency: fx.currency.toUpperCase(), date: fx.date, rateScaled: Math.round(rate * Number(SCALE)) });
    await qc.invalidateQueries();
    setFx({ ...fx, currency: "", rate: "" });
  }
  async function addUser(e: React.FormEvent) {
    e.preventDefault();
    await api.users.post(invite);
    await qc.invalidateQueries({ queryKey: ["users"] });
    setInvite({ email: "", name: "", password: "" });
  }

  return (
    <div className="min-h-screen p-6 md:p-8 max-w-2xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <Link to="/"><Button variant="outline">← Back</Button></Link>
      </div>

      <Card className="p-5 space-y-3">
        <h2 className="font-medium">Exchange rates (to base currency)</h2>
        <form onSubmit={addFx} className="grid grid-cols-4 gap-2 items-end">
          <div><Label>Currency</Label><Input value={fx.currency} maxLength={3} onChange={(e) => setFx({ ...fx, currency: e.target.value })} required /></div>
          <div><Label>Date</Label><Input type="date" value={fx.date} onChange={(e) => setFx({ ...fx, date: e.target.value })} required /></div>
          <div><Label>Rate</Label><Input type="number" step="any" value={fx.rate} onChange={(e) => setFx({ ...fx, rate: e.target.value })} required /></div>
          <Button type="submit">Add</Button>
        </form>
        <div className="space-y-1">
          {(fxQ.data ?? []).map((r) => (
            <div key={r.id} className="flex justify-between text-sm">
              <span>{r.currency} @ {r.date}</span>
              <span className="tabular-nums">{(r.rateScaled / Number(SCALE)).toString()}
                <Button variant="ghost" size="sm" onClick={async () => { await api.fx({ id: r.id }).delete(); await qc.invalidateQueries({ queryKey: ["fx"] }); }}>✕</Button>
              </span>
            </div>
          ))}
        </div>
      </Card>

      <Card className="p-5 space-y-3">
        <h2 className="font-medium">Household members</h2>
        <form onSubmit={addUser} className="grid grid-cols-4 gap-2 items-end">
          <div><Label>Name</Label><Input value={invite.name} onChange={(e) => setInvite({ ...invite, name: e.target.value })} required /></div>
          <div><Label>Email</Label><Input type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} required /></div>
          <div><Label>Password</Label><Input type="password" value={invite.password} onChange={(e) => setInvite({ ...invite, password: e.target.value })} minLength={8} required /></div>
          <Button type="submit">Invite</Button>
        </form>
        <div className="space-y-1">
          {(usersQ.data ?? []).map((u) => (
            <div key={u.id} className="flex justify-between text-sm"><span>{u.name} · {u.email}</span><span className="text-muted-foreground">{u.isAdmin ? "admin" : "member"}</span></div>
          ))}
        </div>
      </Card>

      <Card className="p-5 space-y-3">
        <h2 className="font-medium">Backup</h2>
        <a href={`${API_URL}/export`}><Button variant="outline">Export database (.db)</Button></a>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Full web build**

Run: `cd apps/web && VITE_API_URL=http://localhost:3000 bun run build`
Expected: clean build, no type errors, all pages + dialogs compile.

- [ ] **Step 3: Full test sweep**

Run: `cd /Users/aziz/Workspace/uang && rm -f apps/api/data/sweep.db* && DATABASE_URL=file:./apps/api/data/sweep.db bun test && rm -f apps/api/data/sweep.db*`
Expected: all shared + api tests pass.

- [ ] **Step 4: Manual E2E (controller will also verify)**

Run `bun run dev`, open the web app, sign in, then:
- Add an asset account "Checking" (USD) with opening balance 1000 on a date → appears under Assets, net worth shows $1,000.00.
- Add a liability "Card" (USD), opening -250 → net worth $750.00.
- Add a MYR account, then in Settings add an FX rate MYR @ today = 0.22 → the MYR account shows a base-currency sub-amount and net worth updates; before the rate it shows "⚠ no FX rate".
- Open an account → "Set balance…" to a new number → balance updates. Delete an entry → balance reverts.
- Settings → Export database downloads a `.db` file.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/settings.tsx
git commit -m "feat(web): settings page (FX rates, member invite, export)"
```

---

## Self-Review Notes (coverage vs spec §4–10, ledger scope)

- **Accounts CRUD (spec §4, §10):** Task 4 (create w/ opening, list w/ balance, patch/archive). `holdings` mode rejected in v2 (deferred to Plan 4). ✓
- **Ledger + backfill (spec §6):** Task 5 — `opening` (Task 4), `set-balance`→`adjustment`, `revalue`→`revaluation`, all via the single delta mechanic; list/delete entries. ✓
- **Money/FX (spec §5):** Task 3 valuation engine uses `@uang/shared.convertToBase` with BigInt at the edge, `fromBig` safe-boundary, missing-rate flagged & excluded. Task 6 FX upsert respects the unique index. ✓
- **Net worth headline (spec §5, §10):** Task 7 endpoint + Task 10 dashboard headline & per-account base/native display. Over-time graph deferred to Plan 3. ✓
- **Auth (spec §8):** Task 1 guard protects all new routes; Task 8 admin-only invite; public signup still gated (Plan 1). ✓
- **Export (spec §9):** Task 8 streams the SQLite file; Task 13 button. ✓
- **Web data layer:** Task 9 wires QueryClient + TanStack DB collections (per the confirmed decision); reads via Eden, money formatted via `formatMoney`. ✓
- **Type consistency:** `accountBalanceMinor(accountId, asOf?)`, `netWorth(asOf?)→{baseCurrency,totalBaseMinor,accounts[]}`, `AccountValuation` fields, `set-balance`/`revalue` body shapes, and Eden call shapes are used identically across API and web tasks. Cross-task imports (`account-form`, `settings`) are noted to implement in-session before the final build to avoid unresolved-import placeholders.
- **Deferred (correct absence):** holdings valuation (Plan 4), net-worth-over-time graph (Plan 3), categories/transfers/budgets (Plan 5/Slice 2), realized gains, auto FX/price fetch.
```
