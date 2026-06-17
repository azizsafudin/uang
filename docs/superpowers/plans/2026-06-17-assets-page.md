# Assets Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `/assets` stub with a two-tab view — **Accounts** (allocation + grouped account list) and **Holdings** (portfolio rolled up by instrument + cash) — both scoped by a household/member owner toggle.

**Architecture:** The Accounts tab reuses the existing `GET /networth` endpoint and computes allocation client-side. The Holdings tab is backed by a new `GET /holdings` endpoint (pure rollup lib + thin Elysia route) that walks asset accounts, aggregates securities by instrument and cash by currency (cash/bank/investment subtypes only), all converted to base currency. The page is assembled from three new web components plus a reusable allocation donut.

**Tech Stack:** Bun, Elysia + Drizzle (libsql/SQLite), Eden treaty, React + TanStack Router/Query/DB, recharts (via shadcn `ui/chart`), Tailwind v4, Playwright.

**Spec:** `docs/superpowers/specs/2026-06-17-assets-page-design.md`

---

## File Structure

**API (new):**
- `apps/api/src/lib/holdings.ts` — rollup logic + exported types. One responsibility: turn asset-account positions into a portfolio view.
- `apps/api/src/routes/holdings.ts` — thin Elysia route exposing `GET /holdings`.
- `apps/api/src/routes/holdings.test.ts` — route tests.
- `apps/api/src/app.ts` — register `holdingsRoutes` (one-line modify).

**Web (new):**
- `apps/web/src/components/allocation-donut.tsx` — reusable donut + legend over `{ label, valueBaseMinor }[]`.
- `apps/web/src/components/assets-accounts-tab.tsx` — Accounts tab.
- `apps/web/src/components/assets-holdings-tab.tsx` — Holdings tab.
- `apps/web/src/routes/assets.tsx` — page shell: owner toggle + tabs (rewrite the stub).

**E2E (new):**
- `e2e/tests/assets.spec.ts` — happy-path journey.

---

## Task 1: Holdings rollup lib + route (API)

**Files:**
- Create: `apps/api/src/lib/holdings.ts`
- Create: `apps/api/src/routes/holdings.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/src/routes/holdings.test.ts`

- [ ] **Step 1: Write the failing route test**

Create `apps/api/src/routes/holdings.test.ts`:

```ts
import { expect, test, beforeEach } from "bun:test";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { holdingsRoutes } from "./holdings";
import { db } from "../db/client";
import { accounts, instruments, transactions, prices, accountOwners } from "../db/schema";
import { SCALE } from "@uang/shared";
import { createId, nowEpoch } from "../lib/ids";

beforeEach(resetDb);

const app = makeApp(holdingsRoutes);
const S = Number(SCALE);

async function makeAccount(opts: {
  name: string; subtype: string; currency: string; userId: string;
}): Promise<string> {
  const id = createId();
  await db.insert(accounts).values({
    id, name: opts.name, class: "asset", subtype: opts.subtype, currency: opts.currency,
    isArchived: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy: opts.userId,
  });
  return id;
}

// A cash balance: a currency instrument + a single deposit transaction priced at SCALE.
async function seedCash(accountId: string, currency: string, amountMajor: number) {
  const instrId = createId();
  await db.insert(instruments).values({
    id: instrId, symbol: currency, isin: null, name: currency,
    kind: "currency", currency, createdAt: nowEpoch(),
  });
  await db.insert(transactions).values({
    id: createId(), accountId, instrumentId: instrId, date: "2026-01-01",
    unitsDelta: Math.round(amountMajor * S), unitPriceScaled: S, feesMinor: 0,
    notes: null, createdAt: nowEpoch(), createdBy: "seed",
  });
}

// A security lot: a (shared) instrument + a buy transaction + a current price.
async function seedSecurity(opts: {
  accountId: string; instrumentId: string; symbol: string; name: string;
  currency: string; units: number; buyPrice: number; curPrice: number;
}) {
  // Instrument may be shared across accounts; insert once (ignore dup).
  await db.insert(instruments).values({
    id: opts.instrumentId, symbol: opts.symbol, isin: null, name: opts.name,
    kind: "stock", currency: opts.currency, createdAt: nowEpoch(),
  }).onConflictDoNothing();
  await db.insert(prices).values({
    id: createId(), instrumentId: opts.instrumentId, date: "2026-06-01",
    priceScaled: Math.round(opts.curPrice * S), source: "manual", createdAt: nowEpoch(),
  }).onConflictDoNothing();
  await db.insert(transactions).values({
    id: createId(), accountId: opts.accountId, instrumentId: opts.instrumentId, date: "2026-01-01",
    unitsDelta: Math.round(opts.units * S), unitPriceScaled: Math.round(opts.buyPrice * S),
    feesMinor: 0, notes: null, createdAt: nowEpoch(), createdBy: "seed",
  });
}

test("GET /holdings rolls up the same instrument across two accounts", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const a1 = await makeAccount({ name: "Schwab", subtype: "investment", currency: "USD", userId: "seed" });
  const a2 = await makeAccount({ name: "IBKR", subtype: "investment", currency: "USD", userId: "seed" });
  const aapl = createId();
  await seedSecurity({ accountId: a1, instrumentId: aapl, symbol: "AAPL", name: "Apple", currency: "USD", units: 10, buyPrice: 100, curPrice: 150 });
  await seedSecurity({ accountId: a2, instrumentId: aapl, symbol: "AAPL", name: "Apple", currency: "USD", units: 5, buyPrice: 120, curPrice: 150 });

  const res = await app.handle(new Request("http://localhost/holdings", { headers: { cookie } }));
  expect(res.status).toBe(200);
  const h = await res.json();

  expect(h.securities.length).toBe(1);
  const row = h.securities[0];
  expect(row.symbol).toBe("AAPL");
  expect(row.accountCount).toBe(2);
  // 15 units @ 150 = 2250.00 -> 225000 minor
  expect(row.valueBaseMinor).toBe(225000);
  // gain: (150-100)*10 + (150-120)*5 = 500 + 150 = 650.00 -> 65000 minor
  expect(row.unrealizedGainBaseMinor).toBe(65000);
  expect(h.totalBaseMinor).toBe(225000);
});

test("GET /holdings counts cash only for cash/bank/investment subtypes", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const savings = await makeAccount({ name: "Savings", subtype: "bank", currency: "USD", userId: "seed" });
  await seedCash(savings, "USD", 1000); // counts
  const house = await makeAccount({ name: "House", subtype: "property", currency: "USD", userId: "seed" });
  await seedCash(house, "USD", 500000); // excluded (property)

  const res = await app.handle(new Request("http://localhost/holdings", { headers: { cookie } }));
  const h = await res.json();

  expect(h.securities.length).toBe(0);
  expect(h.cash.length).toBe(1);
  expect(h.cash[0].currency).toBe("USD");
  expect(h.cash[0].valueBaseMinor).toBe(100000); // 1000.00, house excluded
  expect(h.totalBaseMinor).toBe(100000);
});

test("GET /holdings?owner=<member> only includes that member's sole-owned accounts", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const mine = await makeAccount({ name: "Mine", subtype: "bank", currency: "USD", userId: "u1" });
  await db.insert(accountOwners).values({ accountId: mine, userId: "u1" });
  await seedCash(mine, "USD", 100);
  const joint = await makeAccount({ name: "Joint", subtype: "bank", currency: "USD", userId: "u1" });
  await db.insert(accountOwners).values([{ accountId: joint, userId: "u1" }, { accountId: joint, userId: "u2" }]);
  await seedCash(joint, "USD", 200);

  const res = await app.handle(new Request("http://localhost/holdings?owner=u1", { headers: { cookie } }));
  const h = await res.json();
  expect(h.cash[0].valueBaseMinor).toBe(10000); // only "Mine" (100.00)
});

test("GET /holdings returns 401 without auth", async () => {
  const res = await app.handle(new Request("http://localhost/holdings"));
  expect(res.status).toBe(401);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && bun test src/routes/holdings.test.ts`
Expected: FAIL — `Cannot find module "./holdings"` (route not created yet).

- [ ] **Step 3: Create the rollup lib**

Create `apps/api/src/lib/holdings.ts`:

```ts
import { db } from "../db/client";
import { accounts, settings } from "../db/schema";
import { eq } from "drizzle-orm";
import { toBig, fromBig } from "@uang/shared";
import { accountPositions } from "./positions";
import { convertMinor } from "./valuation";
import { getAllOwnerSets } from "./owners";

// Subtypes whose currency balance counts as investable "cash" on the Holdings tab.
// Property/vehicle/other are balance-tracked too, but are NOT portfolio cash.
const CASH_SUBTYPES = new Set(["cash", "bank", "investment"]);

export type SecurityHolding = {
  instrumentId: string;
  symbol: string | null;
  name: string;
  kind: string;                 // "stock" | "etf" | "fund" | "crypto" | "other"
  currency: string;             // instrument currency
  units: number;                // Σ net units across accounts, ×1e8
  valueBaseMinor: number;       // market value converted to base
  unrealizedGainBaseMinor: number;
  accountCount: number;         // distinct in-scope accounts holding it
  missing: boolean;             // any contributing position missing price/FX
};

export type CashHolding = {
  currency: string;
  valueBaseMinor: number;
  accountCount: number;
  missing: boolean;
};

export type Holdings = {
  baseCurrency: string;
  totalBaseMinor: number;                              // securities + cash
  byKind: { kind: string; valueBaseMinor: number }[]; // donut buckets
  securities: SecurityHolding[];                       // sorted by value desc
  cash: CashHolding[];                                 // sorted by value desc
};

export type HoldingsOpts = { asOf?: string; owner?: string };

type SecAgg = {
  symbol: string | null; name: string; kind: string; currency: string;
  units: bigint; valueBase: bigint; gainBase: bigint; accounts: Set<string>; missing: boolean;
};
type CashAgg = { valueBase: bigint; accounts: Set<string>; missing: boolean };

export async function holdings(opts: HoldingsOpts = {}): Promise<Holdings> {
  const { asOf, owner } = opts;
  const s = (await db.select().from(settings).where(eq(settings.id, 1)))[0];
  const base = s?.baseCurrency ?? "USD";
  const accts = await db.select().from(accounts).where(eq(accounts.isArchived, 0));
  const ownerSets = await getAllOwnerSets();

  const secMap = new Map<string, SecAgg>();
  const cashMap = new Map<string, CashAgg>();

  for (const a of accts) {
    if (a.class !== "asset") continue;

    // Same owner filter as netWorth: a specific member sees only sole-owned accounts.
    const ownerIds = ownerSets.get(a.id) ?? [];
    if (owner && owner !== "household") {
      const sole = ownerIds.length === 1 && ownerIds[0] === owner;
      if (!sole) continue;
    }

    const positions = await accountPositions(a.id, asOf);
    for (const p of positions) {
      if (p.instrument.kind === "currency") {
        if (!CASH_SUBTYPES.has(a.subtype)) continue;
        const cur = p.instrumentCurrency;
        let c = cashMap.get(cur);
        if (!c) { c = { valueBase: 0n, accounts: new Set(), missing: false }; cashMap.set(cur, c); }
        c.accounts.add(a.id);
        if (p.missingPrice) { c.missing = true; continue; }
        const conv = await convertMinor(p.marketValueMinor, p.instrumentCurrency, base, base, asOf);
        if (conv === null) { c.missing = true; continue; }
        c.valueBase += toBig(conv);
      } else {
        const key = p.instrument.id;
        let m = secMap.get(key);
        if (!m) {
          m = {
            symbol: p.instrument.symbol, name: p.instrument.name, kind: p.instrument.kind,
            currency: p.instrumentCurrency, units: 0n, valueBase: 0n, gainBase: 0n,
            accounts: new Set(), missing: false,
          };
          secMap.set(key, m);
        }
        m.accounts.add(a.id);
        m.units += toBig(p.units);
        if (p.missingPrice) { m.missing = true; continue; }
        const v = await convertMinor(p.marketValueMinor, p.instrumentCurrency, base, base, asOf);
        const g = await convertMinor(p.unrealizedGainMinor, p.instrumentCurrency, base, base, asOf);
        if (v === null || g === null) { m.missing = true; continue; }
        m.valueBase += toBig(v);
        m.gainBase += toBig(g);
      }
    }
  }

  const securities: SecurityHolding[] = [...secMap.entries()]
    .map(([instrumentId, m]) => ({
      instrumentId, symbol: m.symbol, name: m.name, kind: m.kind, currency: m.currency,
      units: fromBig(m.units), valueBaseMinor: fromBig(m.valueBase),
      unrealizedGainBaseMinor: fromBig(m.gainBase), accountCount: m.accounts.size, missing: m.missing,
    }))
    .sort((a, b) => b.valueBaseMinor - a.valueBaseMinor);

  const cash: CashHolding[] = [...cashMap.entries()]
    .map(([currency, c]) => ({
      currency, valueBaseMinor: fromBig(c.valueBase), accountCount: c.accounts.size, missing: c.missing,
    }))
    .sort((a, b) => b.valueBaseMinor - a.valueBaseMinor);

  const kindTotals = new Map<string, bigint>();
  let total = 0n;
  for (const m of secMap.values()) {
    kindTotals.set(m.kind, (kindTotals.get(m.kind) ?? 0n) + m.valueBase);
    total += m.valueBase;
  }
  let cashTotal = 0n;
  for (const c of cashMap.values()) cashTotal += c.valueBase;
  total += cashTotal;

  const byKind = [...kindTotals.entries()].map(([kind, v]) => ({ kind, valueBaseMinor: fromBig(v) }));
  if (cashTotal > 0n) byKind.push({ kind: "cash", valueBaseMinor: fromBig(cashTotal) });
  byKind.sort((a, b) => b.valueBaseMinor - a.valueBaseMinor);

  return { baseCurrency: base, totalBaseMinor: fromBig(total), byKind, securities, cash };
}
```

- [ ] **Step 4: Create the route**

Create `apps/api/src/routes/holdings.ts`:

```ts
import { Elysia, t } from "elysia";
import { authGuard } from "../lib/auth-guard";
import { holdings } from "../lib/holdings";

export const holdingsRoutes = new Elysia()
  .use(authGuard)
  .get("/holdings", async ({ query }) => holdings({ asOf: query.asOf, owner: query.owner }), {
    query: t.Object({
      asOf: t.Optional(t.String()),
      owner: t.Optional(t.String()),
    }),
  });
```

- [ ] **Step 5: Register the route in app.ts**

In `apps/api/src/app.ts`, add the import alongside the others (after the `networthRoutes` import line):

```ts
import { holdingsRoutes } from "./routes/holdings";
```

And add to the `.use(...)` chain (after `.use(networthRoutes)`):

```ts
    .use(holdingsRoutes)
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/api && bun test src/routes/holdings.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Typecheck (Eden types flow to the web build)**

Run: `cd apps/web && bun run build`
Expected: build succeeds (no type errors). This confirms `api.holdings.get` is now typed end-to-end.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/lib/holdings.ts apps/api/src/routes/holdings.ts apps/api/src/routes/holdings.test.ts apps/api/src/app.ts
git commit -m "feat(api): GET /holdings — cross-account portfolio rollup"
```

---

## Task 2: Reusable allocation donut (web)

**Files:**
- Create: `apps/web/src/components/allocation-donut.tsx`

- [ ] **Step 1: Create the component**

Create `apps/web/src/components/allocation-donut.tsx`. Mirrors `goal-donut.tsx`'s recharts usage and the shared `--chart-*` palette.

```tsx
import { Cell, Pie, PieChart } from "recharts";
import { ChartContainer, type ChartConfig } from "@/components/ui/chart";
import { Money } from "@/components/money";

const SLICE_COLORS = [
  "var(--chart-1)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-2)",
  "var(--chart-5)",
];
export const sliceColor = (i: number): string => SLICE_COLORS[i % SLICE_COLORS.length];

const emptyConfig = {} satisfies ChartConfig;

export type AllocationSlice = { label: string; valueBaseMinor: number };

// A donut split by allocation bucket, with a legend listing each bucket's value
// and % of total. Buckets arrive pre-sorted (largest first) from the caller.
export function AllocationDonut({
  slices,
  baseCurrency,
  size = 132,
}: {
  slices: AllocationSlice[];
  baseCurrency: string;
  size?: number;
}) {
  const total = slices.reduce((sum, s) => sum + Math.max(0, s.valueBaseMinor), 0);
  const data = slices
    .filter((s) => s.valueBaseMinor > 0)
    .map((s, i) => ({ key: s.label, value: s.valueBaseMinor, color: sliceColor(i) }));

  if (data.length === 0) {
    return <p className="text-sm text-muted-foreground">No allocation to show.</p>;
  }

  const outer = Math.round(size * 0.46);
  const inner = Math.round(size * 0.31);

  return (
    <div className="flex flex-wrap items-center gap-5">
      <div style={{ height: size, width: size }} className="shrink-0">
        <ChartContainer config={emptyConfig} className="h-full w-full">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="key" innerRadius={inner} outerRadius={outer} strokeWidth={2}>
              {data.map((d) => (
                <Cell key={d.key} fill={d.color} />
              ))}
            </Pie>
          </PieChart>
        </ChartContainer>
      </div>
      <ul className="flex min-w-0 flex-col gap-2 text-sm">
        {data.map((d) => {
          const pct = total > 0 ? Math.round((d.value / total) * 100) : 0;
          return (
            <li key={d.key} className="flex items-center gap-2">
              <span className="size-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: d.color }} />
              <span className="truncate">{d.key}</span>
              <span className="ml-auto whitespace-nowrap tabular-nums text-muted-foreground">
                <Money minor={d.value} currency={baseCurrency} /> · {pct}%
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && bun run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/allocation-donut.tsx
git commit -m "feat(web): reusable AllocationDonut component"
```

---

## Task 3: Accounts tab (web)

**Files:**
- Create: `apps/web/src/components/assets-accounts-tab.tsx`

Reuses `/networth` data (fetched by the page in Task 5 and passed in), `account-grouping`, `Money`, `subtypeLabel`, and `AllocationDonut`.

- [ ] **Step 1: Create the component**

Create `apps/web/src/components/assets-accounts-tab.tsx`:

```tsx
import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { Money } from "@/components/money";
import { subtypeLabel } from "@/components/labels";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AllocationDonut, type AllocationSlice } from "@/components/allocation-donut";
import { groupsCollection } from "@/lib/collections";
import { useUsers } from "@/lib/use-users";
import type { AccountValuation } from "@/lib/account-grouping";

type Dimension = "type" | "currency" | "owner" | "liquidity";
const DIMENSIONS: { key: Dimension; label: string }[] = [
  { key: "type", label: "By type" },
  { key: "currency", label: "Currency" },
  { key: "owner", label: "Owner" },
  { key: "liquidity", label: "Liquidity" },
];

// Bucket asset accounts by the chosen dimension, summing base value. Accounts
// missing a rate are excluded (no reliable base value). Returns largest-first.
function bucketize(
  accounts: AccountValuation[],
  dim: Dimension,
  userName: (id: string) => string,
): AllocationSlice[] {
  const totals = new Map<string, number>();
  for (const a of accounts) {
    if (a.missingRate) continue;
    let label: string;
    if (dim === "type") label = subtypeLabel(a.subtype);
    else if (dim === "currency") label = a.currency;
    else if (dim === "liquidity") label = a.illiquid ? "Illiquid" : "Liquid";
    else label = a.ownerIds.length >= 2 ? "Shared" : a.ownerIds.map(userName).join(", ") || "Unassigned";
    totals.set(label, (totals.get(label) ?? 0) + a.baseMinor);
  }
  return [...totals.entries()]
    .map(([label, valueBaseMinor]) => ({ label, valueBaseMinor }))
    .sort((a, b) => b.valueBaseMinor - a.valueBaseMinor);
}

type Section = { id: string; name: string; accounts: AccountValuation[]; subtotal: number };

const subtotalOf = (xs: AccountValuation[]) =>
  xs.filter((a) => !a.missingRate).reduce((s, a) => s + a.baseMinor, 0);

// Group asset accounts by their user-defined group (group.sortOrder order),
// ungrouped accounts last. Read-only here — grouping is managed on the dashboard.
function sectionize(
  accounts: AccountValuation[],
  groups: { id: string; name: string; sortOrder: number }[],
): Section[] {
  const known = new Set(groups.map((g) => g.id));
  const out: Section[] = [];
  for (const g of [...groups].sort((a, b) => a.sortOrder - b.sortOrder)) {
    const mem = accounts.filter((a) => a.groupId === g.id).sort((a, b) => b.baseMinor - a.baseMinor);
    if (mem.length > 0) out.push({ id: g.id, name: g.name, accounts: mem, subtotal: subtotalOf(mem) });
  }
  const ungrouped = accounts
    .filter((a) => !a.groupId || !known.has(a.groupId))
    .sort((a, b) => b.baseMinor - a.baseMinor);
  if (ungrouped.length > 0) {
    out.push({ id: "__ungrouped", name: "Ungrouped", accounts: ungrouped, subtotal: subtotalOf(ungrouped) });
  }
  return out;
}

export function AssetsAccountsTab({
  accounts,
  baseCurrency,
}: {
  accounts: AccountValuation[]; // asset accounts only, already owner-filtered
  baseCurrency: string;
}) {
  const [dim, setDim] = useState<Dimension>("type");
  const { data: users } = useUsers();
  const { data: allGroups } = useLiveQuery(groupsCollection);
  const userName = useMemo(() => {
    const m = new Map((users ?? []).map((u) => [u.id, u.name] as const));
    return (id: string) => m.get(id) ?? "Unknown";
  }, [users]);

  const total = accounts.filter((a) => !a.missingRate).reduce((sum, a) => sum + a.baseMinor, 0);
  const slices = useMemo(() => bucketize(accounts, dim, userName), [accounts, dim, userName]);
  const sections = useMemo(
    () => sectionize(accounts, (allGroups ?? []).filter((g) => g.class === "asset")),
    [accounts, allGroups],
  );

  if (accounts.length === 0) {
    return <p className="mt-6 text-sm text-muted-foreground">No assets yet.</p>;
  }

  return (
    <div className="mt-6 space-y-6">
      <div className="flex flex-wrap gap-1.5">
        {DIMENSIONS.map((d) => (
          <Button
            key={d.key}
            size="sm"
            variant={dim === d.key ? "default" : "outline"}
            onClick={() => setDim(d.key)}
            className={cn(dim === d.key && "pointer-events-none")}
          >
            {d.label}
          </Button>
        ))}
      </div>

      <AllocationDonut slices={slices} baseCurrency={baseCurrency} />

      <div className="space-y-5">
        {sections.map((sec) => (
          <div key={sec.id}>
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">{sec.name}</span>
              <span className="text-xs tabular-nums text-muted-foreground">
                <Money minor={sec.subtotal} currency={baseCurrency} />
              </span>
            </div>
            <ul className="rounded-2xl border border-border bg-card">
              {sec.accounts.map((a) => {
                const pct = total > 0 && !a.missingRate ? Math.round((a.baseMinor / total) * 100) : 0;
                return (
                  <li key={a.id} className="border-b border-border/60 last:border-b-0">
                    <Link
                      to="/accounts/$id"
                      params={{ id: a.id }}
                      data-testid="account-row"
                      className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-accent/40"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm">{a.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {a.currency} · {subtypeLabel(a.subtype)}
                        </p>
                      </div>
                      <div className="text-right">
                        {a.missingRate ? (
                          <span className="text-sm text-destructive">missing rate</span>
                        ) : (
                          <>
                            <p className="text-sm tabular-nums">
                              <Money minor={a.baseMinor} currency={baseCurrency} />
                            </p>
                            <p className="text-[0.7rem] tabular-nums text-muted-foreground">{pct}%</p>
                          </>
                        )}
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && bun run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/assets-accounts-tab.tsx
git commit -m "feat(web): Assets — Accounts tab (allocation + account list)"
```

---

## Task 4: Holdings tab (web)

**Files:**
- Create: `apps/web/src/components/assets-holdings-tab.tsx`

Consumes the new `/holdings` endpoint via TanStack Query.

- [ ] **Step 1: Create the component**

Create `apps/web/src/components/assets-holdings-tab.tsx`:

```tsx
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "@/lib/api";
import { Money } from "@/components/money";
import { instrumentKindLabel } from "@/components/labels";
import { AllocationDonut, type AllocationSlice } from "@/components/allocation-donut";

type Holdings = {
  baseCurrency: string;
  totalBaseMinor: number;
  byKind: { kind: string; valueBaseMinor: number }[];
  securities: {
    instrumentId: string; symbol: string | null; name: string; kind: string; currency: string;
    units: number; valueBaseMinor: number; unrealizedGainBaseMinor: number; accountCount: number; missing: boolean;
  }[];
  cash: { currency: string; valueBaseMinor: number; accountCount: number; missing: boolean }[];
};

async function fetchHoldings(owner: string): Promise<Holdings> {
  const { data, error } = await api.holdings.get({ query: { owner } });
  if (error) throw new Error(String(error));
  return data as unknown as Holdings;
}

const fmtUnits = (unitsScaled: number) =>
  (unitsScaled / 1e8).toLocaleString(undefined, { maximumFractionDigits: 4 });

const accts = (n: number) => `${n} account${n === 1 ? "" : "s"}`;

export function AssetsHoldingsTab({ owner }: { owner: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["holdings", owner],
    queryFn: () => fetchHoldings(owner),
  });

  const base = data?.baseCurrency ?? "";
  // byKind emits "cash" for the cash bucket; instrumentKindLabel keys on "currency".
  const kindLabel = (k: string) => (k === "cash" ? "Cash" : instrumentKindLabel(k));
  const slices: AllocationSlice[] = useMemo(
    () => (data?.byKind ?? []).map((b) => ({ label: kindLabel(b.kind), valueBaseMinor: b.valueBaseMinor })),
    [data],
  );

  if (isLoading) {
    return <div className="mt-6 h-48 animate-pulse rounded-2xl bg-muted/40" />;
  }
  if (!data || (data.securities.length === 0 && data.cash.length === 0)) {
    return <p className="mt-6 text-sm text-muted-foreground">No holdings yet.</p>;
  }

  return (
    <div className="mt-6 space-y-6">
      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Portfolio value</p>
        <p data-testid="holdings-total" className="font-heading text-2xl tabular-nums">
          <Money minor={data.totalBaseMinor} currency={base} />
        </p>
      </div>

      <AllocationDonut slices={slices} baseCurrency={base} />

      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2 text-left font-medium">Holding</th>
              <th className="px-4 py-2 text-right font-medium">Units</th>
              <th className="px-4 py-2 text-right font-medium">Value</th>
              <th className="px-4 py-2 text-right font-medium">% port</th>
              <th className="px-4 py-2 text-right font-medium">Unrealized</th>
            </tr>
          </thead>
          <tbody>
            {data.securities.length > 0 && (
              <tr><td colSpan={5} className="px-4 pt-3 pb-1 text-xs uppercase tracking-wide text-muted-foreground">Securities</td></tr>
            )}
            {data.securities.map((s) => {
              const pct = data.totalBaseMinor > 0 ? Math.round((s.valueBaseMinor / data.totalBaseMinor) * 100) : 0;
              const up = s.unrealizedGainBaseMinor >= 0;
              return (
                <tr key={s.instrumentId} data-testid="holding-row" className="border-b border-border/60 last:border-b-0 hover:bg-accent/40">
                  <td className="px-4 py-3">
                    <Link to="/instruments/$id" params={{ id: s.instrumentId }} className="block">
                      <span className="font-medium">{s.symbol ?? s.name}</span>
                      <span className="ml-2 rounded-full bg-accent px-2 py-0.5 text-[0.65rem] text-muted-foreground">
                        {instrumentKindLabel(s.kind)}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">{s.name} · {accts(s.accountCount)}</span>
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmtUnits(s.units)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {s.missing ? <span className="text-destructive">—</span> : <Money minor={s.valueBaseMinor} currency={base} />}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{pct}%</td>
                  <td className={cnGain(up)}>
                    {up ? "▲ " : "▼ "}<Money minor={Math.abs(s.unrealizedGainBaseMinor)} currency={base} />
                  </td>
                </tr>
              );
            })}

            {data.cash.length > 0 && (
              <tr><td colSpan={5} className="px-4 pt-3 pb-1 text-xs uppercase tracking-wide text-muted-foreground">Cash</td></tr>
            )}
            {data.cash.map((c) => {
              const pct = data.totalBaseMinor > 0 ? Math.round((c.valueBaseMinor / data.totalBaseMinor) * 100) : 0;
              return (
                <tr key={c.currency} data-testid="cash-row" className="border-b border-border/60 last:border-b-0">
                  <td className="px-4 py-3">
                    <span className="font-medium">{c.currency}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{accts(c.accountCount)}</span>
                  </td>
                  <td className="px-4 py-3 text-right text-muted-foreground">—</td>
                  <td className="px-4 py-3 text-right tabular-nums"><Money minor={c.valueBaseMinor} currency={base} /></td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{pct}%</td>
                  <td className="px-4 py-3 text-right text-muted-foreground">—</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Gain column color: pine for up, brick for down.
function cnGain(up: boolean): string {
  return `px-4 py-3 text-right tabular-nums ${up ? "text-primary" : "text-destructive"}`;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && bun run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/assets-holdings-tab.tsx
git commit -m "feat(web): Assets — Holdings tab (securities + cash rollup)"
```

---

## Task 5: Assemble the Assets page (web)

**Files:**
- Modify (rewrite): `apps/web/src/routes/assets.tsx`

Owns the owner toggle + total header, fetches `/networth` (for the Accounts tab and the total), and renders the two tabs. Tab + owner are local state.

- [ ] **Step 1: Rewrite the page**

Replace the contents of `apps/web/src/routes/assets.tsx`:

```tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { AppShell } from "@/components/app-layout";
import { PageHeader } from "@/components/page-header";
import { Money } from "@/components/money";
import { NetWorthToggle } from "@/components/net-worth-toggle";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AssetsAccountsTab } from "@/components/assets-accounts-tab";
import { AssetsHoldingsTab } from "@/components/assets-holdings-tab";
import { visibleForOwner, type AccountValuation } from "@/lib/account-grouping";

type NetWorth = { baseCurrency: string; accounts: AccountValuation[] };

async function fetchNw(): Promise<NetWorth> {
  const { data, error } = await api.networth.get({ query: { owner: "household" } });
  if (error) throw new Error(String(error));
  return data as unknown as NetWorth;
}

export function AssetsPage() {
  const [owner, setOwner] = useState("household");
  const [tab, setTab] = useState("accounts");

  // Fetch the whole household once; the owner toggle filters client-side.
  const { data } = useQuery({ queryKey: ["networth", "household"], queryFn: fetchNw });
  const base = data?.baseCurrency ?? "";
  const assetAccounts = visibleForOwner(data?.accounts ?? [], owner).filter((a) => a.class === "asset");
  const total = assetAccounts.filter((a) => !a.missingRate).reduce((sum, a) => sum + a.baseMinor, 0);

  return (
    <AppShell>
      <PageHeader
        eyebrow="Holdings"
        title="Assets"
        actions={<NetWorthToggle value={owner} onChange={setOwner} />}
      />
      <p data-testid="assets-total" className="-mt-3 font-heading text-4xl tabular-nums tracking-tight">
        {data ? <Money minor={total} currency={base} /> : "—"}
      </p>

      <Tabs value={tab} onValueChange={(v) => typeof v === "string" && setTab(v)} className="mt-8">
        <TabsList variant="line" className="w-full justify-start">
          <TabsTrigger value="accounts" className="flex-none px-3">Accounts</TabsTrigger>
          <TabsTrigger value="holdings" className="flex-none px-3">Holdings</TabsTrigger>
        </TabsList>

        <TabsContent value="accounts">
          <AssetsAccountsTab accounts={assetAccounts} baseCurrency={base} />
        </TabsContent>
        <TabsContent value="holdings">
          <AssetsHoldingsTab owner={owner} />
        </TabsContent>
      </Tabs>
    </AppShell>
  );
}
```

Note: the Accounts-tab total in the header follows the owner toggle. The Holdings tab shows its own portfolio total inside its allocation/table (the header total is "total assets", which legitimately differs from portfolio value — property is in one, not the other).

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && bun run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/assets.tsx
git commit -m "feat(web): assemble Assets page (owner toggle + Accounts/Holdings tabs)"
```

---

## Task 6: E2E journey (Playwright)

**Files:**
- Create: `e2e/tests/assets.spec.ts`

Happy path reachable with existing helpers (`createAccount` + `addCashDeposit`): create two cash accounts, then on `/assets` verify the Accounts tab lists them with the owner toggle, and the Holdings tab shows a Cash row.

- [ ] **Step 1: Write the spec**

Create `e2e/tests/assets.spec.ts`:

```ts
import { test, expect } from "./fixtures";
import { seedHousehold, createAccount, addCashDeposit } from "./helpers";

test.beforeEach(async ({ backend, request, context }) => {
  await backend.freshDb();
  await seedHousehold(request, context, backend.apiURL);
});

test("assets page: accounts tab lists assets, holdings tab shows cash", async ({ page }) => {
  await test.step("create and fund a savings account", async () => {
    await page.goto("/");
    await createAccount(page, { name: "Savings", currency: "USD" });
    await page.getByTestId("account-row").filter({ hasText: "Savings" }).click();
    await expect(page).toHaveURL(/\/accounts\//);
    await addCashDeposit(page, { amount: "1000", currency: "USD" });
  });

  await test.step("accounts tab shows the asset and total", async () => {
    await page.getByRole("link", { name: "Assets" }).click();
    await expect(page.getByRole("heading", { name: "Assets" })).toBeVisible();
    await expect(page.getByTestId("assets-total")).toContainText("1,000.00");
    await expect(page.getByTestId("account-row").filter({ hasText: "Savings" })).toBeVisible();
  });

  await test.step("holdings tab rolls the cash up by currency", async () => {
    await page.getByRole("tab", { name: "Holdings" }).click();
    const cashRow = page.getByTestId("cash-row").filter({ hasText: "USD" });
    await expect(cashRow).toBeVisible();
    await expect(cashRow).toContainText("1,000.00");
  });
});
```

- [ ] **Step 2: Run the affected spec**

Run: `bun run e2e -- assets.spec.ts`
Expected: PASS. (If the run flags a cold-compile timeout on first boot, re-run once — the harness absorbs the warm-up.)

- [ ] **Step 3: Commit**

```bash
git add e2e/tests/assets.spec.ts
git commit -m "test(e2e): assets page journey (accounts + holdings tabs)"
```

---

## Final verification

- [ ] `cd apps/api && bun test src/routes/holdings.test.ts` — green.
- [ ] `cd apps/web && bun run build` — clean typecheck/build.
- [ ] `bun run e2e -- assets.spec.ts` — green.
- [ ] Manually click through `/assets`: owner toggle filters both tabs; dimension chips re-bucket the donut; an account row → account detail; a securities row → instrument detail.
```
