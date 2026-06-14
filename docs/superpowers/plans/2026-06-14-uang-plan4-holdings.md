# Uang — Plan 4: Investment Holdings & Per-Lot Appreciation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track investment accounts as lots (units bought at a price/date) valued with manually-entered carry-forward prices, show per-lot unrealized gain, and roll holdings into net worth as-of-aware (so the future net-worth graph includes investments automatically).

**Architecture:** A new `holdings.ts` valuation lib (pure `lotValuation` + DB-backed `instrumentPriceScaled` and `holdingsAccountValuation`) that `netWorth` delegates to per account based on `valuation_mode`. New REST routes for instruments, lots, prices, and a server-computed holdings payload. Web: a valuation-mode toggle on the account form, and a holdings branch on the account-detail page (lots table, per-lot gain, add/edit/delete lot, update price with inline instrument creation), backed by new TanStack DB collections.

**Tech Stack:** (unchanged) Bun, ElysiaJS, libSQL/Drizzle, better-auth, TanStack Router, TanStack DB + TanStack Query, shadcn/ui + Tailwind, Eden Treaty. Tests: `bun test` (API) from `apps/api`; `bun run build` is the gate for web from `apps/web`.

> **Scope:** Plan 4 of the build. **In:** holdings account creation; instruments (inline-create); lots CRUD; manual prices (upsert per instrument+date, dated history); the holdings valuation engine; `netWorth` integration (mixed, as-of-aware); holdings detail UI. **Deferred (own cycles):** auto price-fetch; realized-gain cost-basis methods; the net-worth-over-time graph itself (this slice only guarantees `netWorth(asOf)` already values holdings). **No DB migration** — `instruments`/`lots`/`prices` and `accounts.valuation_mode` already exist.

> **Money/units at the JSON boundary:** DB stores money as integer minor units, units/prices/rates as integers scaled by `SCALE = 1e8`. `@uang/shared` does the math in `BigInt` (`toBig`/`fromBig`/`roundDiv`/`convertToBase`). The API serializes everything as JS **numbers** (household magnitudes stay < 2^53). Convert `Number ↔ BigInt` only at the math edge.

> **Display rule (from spec §4):** a holdings account's total is reported in **base currency** (single instrument→base FX hop). Per-lot cost/value/gain are shown in each **instrument's** currency. In the `netWorth` per-account entry, a holdings account reports `currency = base`, `balanceMinor = baseMinor = its holdings base total`.

---

## File Structure

```
apps/api/src/
├── lib/
│   ├── fx.ts            # NEW: latestFxRateScaled (extracted from valuation.ts; shared by valuation + holdings)
│   ├── valuation.ts     # MODIFIED: import fx from fx.ts; netWorth branches holdings -> holdings.ts
│   ├── valuation.test.ts# MODIFIED: mixed ledger+holdings netWorth tests
│   ├── holdings.ts      # NEW: instrumentPriceScaled, lotValuation, holdingsAccountValuation
│   └── holdings.test.ts # NEW
├── routes/
│   ├── accounts.ts      # MODIFIED: allow valuationMode='holdings' (remove rejection)
│   ├── accounts.test.ts # MODIFIED: holdings-account create test
│   ├── instruments.ts   # NEW: GET/POST /instruments
│   ├── instruments.test.ts # NEW
│   ├── lots.ts          # NEW: GET/POST /accounts/:id/lots; PATCH/DELETE /lots/:id; GET /accounts/:id/holdings
│   ├── lots.test.ts     # NEW
│   ├── prices.ts        # NEW: GET/POST /instruments/:id/prices; DELETE /prices/:id
│   └── prices.test.ts   # NEW
├── lib/test-helpers.ts  # MODIFIED: resetDb clears instruments/lots/prices
└── app.ts               # MODIFIED: mount instruments/lots/prices routes

apps/web/src/
├── lib/
│   └── collections.ts   # MODIFIED: instrumentsCollection, lotsCollection(accountId), pricesCollection(instrumentId) + row types
├── components/
│   ├── account-form.tsx # MODIFIED: valuation-mode toggle; hide opening balance for holdings
│   ├── add-lot-dialog.tsx   # NEW: add a lot (+ inline instrument create)
│   ├── update-price.tsx     # NEW: set an instrument's price (date + amount)
│   └── holdings-detail.tsx  # NEW: holdings account body (totals, lots table, actions)
└── routes/
    └── account-detail.tsx   # MODIFIED: branch on valuation_mode (ledger vs holdings)
```

> **Circular-import note:** `holdings.ts` needs the FX lookup and `valuation.ts` needs the holdings valuation. To avoid a cycle, Task 1 extracts `latestFxRateScaled` into `fx.ts`; both libs import it from there.

> **Test DB note:** API tests share `apps/api/data/uang.db` (the default `DATABASE_URL`). Run API test tasks sequentially.

---

## Task 1: Extract the FX lookup into `fx.ts`

**Files:**
- Create: `apps/api/src/lib/fx.ts`
- Modify: `apps/api/src/lib/valuation.ts`

- [ ] **Step 1: Create the fx lib**

Create `apps/api/src/lib/fx.ts`:

```ts
import { db } from "../db/client";
import { fxRates } from "../db/schema";
import { and, eq, lte, desc } from "drizzle-orm";

// Latest fx_rate.rate_scaled for `currency` with date <= asOf (or latest overall
// if asOf is absent). null if no rate exists. rate_scaled = base-major per 1 from-major * SCALE.
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
```

- [ ] **Step 2: Update valuation.ts to import from fx.ts**

In `apps/api/src/lib/valuation.ts`:

Delete the existing `latestFxRateScaled` function definition (the whole `export async function latestFxRateScaled(...) { ... }` block).

Add this import near the top (after the existing imports):

```ts
import { latestFxRateScaled } from "./fx";
```

Then re-export it so existing importers (if any) keep working — add at the end of the file, next to `export { SCALE };`:

```ts
export { latestFxRateScaled };
```

Remove now-unused imports from valuation.ts's drizzle import if `lte`/`desc` are no longer used there (check: `accountBalanceMinor` still uses `and`, `eq`, `lte`, `sql`; `netWorth` uses `eq`. `desc` was only used by the moved function — remove `desc` from the `drizzle-orm` import in valuation.ts if it's now unused).

- [ ] **Step 3: Run the existing valuation tests (must stay green)**

Run: `cd /Users/aziz/Workspace/uang/apps/api && bun test src/lib/valuation.test.ts`
Expected: PASS — all existing valuation tests still green (pure refactor; behavior unchanged).

- [ ] **Step 4: Commit**

```bash
cd /Users/aziz/Workspace/uang && git add apps/api/src/lib/fx.ts apps/api/src/lib/valuation.ts && git commit -m "refactor(api): extract latestFxRateScaled into fx.ts"
```

---

## Task 2: `holdings.ts` — `instrumentPriceScaled` + `lotValuation`

**Files:**
- Create: `apps/api/src/lib/holdings.ts`
- Create: `apps/api/src/lib/holdings.test.ts`
- Modify: `apps/api/src/lib/test-helpers.ts`

- [ ] **Step 1: Add instruments/lots/prices to resetDb**

In `apps/api/src/lib/test-helpers.ts`, extend the schema import and clear the new tables in `resetDb`.

Change the schema import line from:
```ts
import { settings, user, accounts, accountOwners, entries, fxRates } from "../db/schema";
```
to:
```ts
import { settings, user, accounts, accountOwners, entries, fxRates, instruments, lots, prices } from "../db/schema";
```

In `resetDb`, add these deletes right after `await db.delete(accountOwners);` (clear lots/prices before their parents):
```ts
  await db.delete(lots);
  await db.delete(prices);
  await db.delete(instruments);
```

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/lib/holdings.test.ts`:

```ts
import { expect, test, beforeEach } from "bun:test";
import { resetDb } from "./test-helpers";
import { db } from "../db/client";
import { instruments, prices } from "../db/schema";
import { createId, nowEpoch } from "./ids";
import { instrumentPriceScaled, lotValuation } from "./holdings";

const SCALE = 100_000_000; // 1e8

beforeEach(resetDb);

async function addInstrument(p: { currency: string }) {
  const id = createId();
  await db.insert(instruments).values({
    id, symbol: "X", isin: null, name: "X Corp", kind: "stock", currency: p.currency, createdAt: nowEpoch(),
  });
  return id;
}
async function addPrice(instrumentId: string, date: string, priceMajor: number) {
  await db.insert(prices).values({
    id: createId(), instrumentId, date, priceScaled: Math.round(priceMajor * SCALE), source: "manual", createdAt: nowEpoch(),
  });
}

test("instrumentPriceScaled carries forward the latest price <= asOf", async () => {
  const i = await addInstrument({ currency: "USD" });
  await addPrice(i, "2026-01-01", 100);
  await addPrice(i, "2026-03-01", 120);
  expect(await instrumentPriceScaled(i, "2026-02-15")).toBe(100 * SCALE);
  expect(await instrumentPriceScaled(i, "2026-03-01")).toBe(120 * SCALE);
  expect(await instrumentPriceScaled(i, "2025-12-31")).toBe(null);
  expect(await instrumentPriceScaled(i)).toBe(120 * SCALE); // no asOf -> latest
});

test("lotValuation: USD instrument, fractional units, fees", () => {
  // 10 shares @ price 123.45, cost 100.00/unit, fees $5.00, USD (2 decimals)
  const v = lotValuation(
    { unitsScaled: 10 * SCALE, unitCostScaled: 100 * SCALE, feesMinor: 500 },
    123.45 * SCALE,
    2,
  );
  expect(v.mvMinor).toBe(123450);   // 10 * 123.45 = 1234.50
  expect(v.costMinor).toBe(100500); // 10 * 100 + 5 fees = 1005.00
  expect(v.gainMinor).toBe(22950);  // 229.50
});

test("lotValuation: JPY instrument (0 decimals), gain and loss", () => {
  // 5 units @ 2000, cost 1500, fees 0, JPY (0 decimals)
  const gain = lotValuation(
    { unitsScaled: 5 * SCALE, unitCostScaled: 1500 * SCALE, feesMinor: 0 },
    2000 * SCALE,
    0,
  );
  expect(gain.mvMinor).toBe(10000);   // 5 * 2000
  expect(gain.costMinor).toBe(7500);  // 5 * 1500
  expect(gain.gainMinor).toBe(2500);
  // a loss: price 1000 < cost 1500
  const loss = lotValuation(
    { unitsScaled: 5 * SCALE, unitCostScaled: 1500 * SCALE, feesMinor: 0 },
    1000 * SCALE,
    0,
  );
  expect(loss.gainMinor).toBe(-2500);
});

test("lotValuation: 1.5 units @ 10.00 USD = 15.00", () => {
  const v = lotValuation(
    { unitsScaled: 1.5 * SCALE, unitCostScaled: 10 * SCALE, feesMinor: 0 },
    10 * SCALE,
    2,
  );
  expect(v.mvMinor).toBe(1500);
  expect(v.costMinor).toBe(1500);
  expect(v.gainMinor).toBe(0);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd /Users/aziz/Workspace/uang/apps/api && bun test src/lib/holdings.test.ts`
Expected: FAIL — `Cannot find module './holdings'`.

- [ ] **Step 4: Implement**

Create `apps/api/src/lib/holdings.ts`:

```ts
import { db } from "../db/client";
import { prices } from "../db/schema";
import { and, eq, lte, desc } from "drizzle-orm";
import { SCALE, roundDiv, toBig, fromBig } from "@uang/shared";

// Latest manual price for an instrument with date <= asOf (carry-forward),
// or latest overall if asOf absent. null if none. Returns price_scaled (price-per-unit * 1e8).
export async function instrumentPriceScaled(instrumentId: string, asOf?: string): Promise<number | null> {
  const where = asOf
    ? and(eq(prices.instrumentId, instrumentId), lte(prices.date, asOf))
    : eq(prices.instrumentId, instrumentId);
  const rows = await db
    .select({ priceScaled: prices.priceScaled })
    .from(prices)
    .where(where)
    .orderBy(desc(prices.date))
    .limit(1);
  return rows[0]?.priceScaled ?? null;
}

export type LotInput = { unitsScaled: number; unitCostScaled: number; feesMinor: number };
export type LotValue = { mvMinor: number; costMinor: number; gainMinor: number };

// Market value, cost, and unrealized gain for a lot, all in the INSTRUMENT's currency
// minor units. instrDec = currencyDecimals(instrument.currency).
//   mv   = round( units_scaled * price_scaled * 10^instrDec / (SCALE * SCALE) )
//   cost = round( units_scaled * unit_cost_scaled * 10^instrDec / (SCALE * SCALE) ) + fees_minor
export function lotValuation(lot: LotInput, priceScaled: number, instrDec: number): LotValue {
  const units = toBig(lot.unitsScaled);
  const scale2 = SCALE * SCALE;
  const tenDec = 10n ** BigInt(instrDec);
  const mvBig = roundDiv(units * toBig(priceScaled) * tenDec, scale2);
  const costBig = roundDiv(units * toBig(lot.unitCostScaled) * tenDec, scale2) + toBig(lot.feesMinor);
  const mvMinor = fromBig(mvBig);
  const costMinor = fromBig(costBig);
  return { mvMinor, costMinor, gainMinor: mvMinor - costMinor };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd /Users/aziz/Workspace/uang/apps/api && bun test src/lib/holdings.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
cd /Users/aziz/Workspace/uang && git add apps/api/src/lib/holdings.ts apps/api/src/lib/holdings.test.ts apps/api/src/lib/test-helpers.ts && git commit -m "feat(api): holdings lib — instrumentPriceScaled + lotValuation"
```

---

## Task 3: `holdingsAccountValuation`

**Files:**
- Modify: `apps/api/src/lib/holdings.ts`
- Modify: `apps/api/src/lib/holdings.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/lib/holdings.test.ts`:

First extend the imports — change:
```ts
import { instruments, prices } from "../db/schema";
```
to:
```ts
import { instruments, prices, accounts, lots, fxRates } from "../db/schema";
```
and change:
```ts
import { instrumentPriceScaled, lotValuation } from "./holdings";
```
to:
```ts
import { instrumentPriceScaled, lotValuation, holdingsAccountValuation } from "./holdings";
```

Add these helpers after the existing `addPrice` helper:
```ts
async function addHoldingsAccount(currency = "USD") {
  const id = createId();
  await db.insert(accounts).values({
    id, name: "Broker", class: "asset", subtype: "investment", currency,
    valuationMode: "holdings", isArchived: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy: "u1",
  });
  return id;
}
async function addLot(p: { accountId: string; instrumentId: string; unitsMajor: number; unitCostMajor: number; feesMinor?: number; tradeDate: string }) {
  await db.insert(lots).values({
    id: createId(), accountId: p.accountId, instrumentId: p.instrumentId,
    unitsScaled: Math.round(p.unitsMajor * SCALE), unitCostScaled: Math.round(p.unitCostMajor * SCALE),
    feesMinor: p.feesMinor ?? 0, tradeDate: p.tradeDate, note: null, createdAt: nowEpoch(), createdBy: "u1",
  });
}
async function addFx(currency: string, date: string, rateMajor: number) {
  await db.insert(fxRates).values({ id: createId(), currency, date, rateScaled: Math.round(rateMajor * SCALE), createdAt: nowEpoch() });
}
```

Append these tests:
```ts
test("holdingsAccountValuation: single USD lot, base USD", async () => {
  const acc = await addHoldingsAccount("USD");
  const i = await addInstrument({ currency: "USD" });
  await addPrice(i, "2026-01-01", 123.45);
  await addLot({ accountId: acc, instrumentId: i, unitsMajor: 10, unitCostMajor: 100, feesMinor: 500, tradeDate: "2026-01-01" });

  const v = await holdingsAccountValuation(acc, undefined, "USD");
  expect(v.baseMinor).toBe(123450);
  expect(v.gainBaseMinor).toBe(22950);
  expect(v.missing).toBe(false);
  expect(v.lots.length).toBe(1);
  expect(v.lots[0].mvBaseMinor).toBe(123450);
});

test("holdingsAccountValuation: JPY instrument converted to USD base via FX", async () => {
  const acc = await addHoldingsAccount("USD");
  const i = await addInstrument({ currency: "JPY" });
  await addPrice(i, "2026-01-01", 2000);                 // ¥2000
  await addLot({ accountId: acc, instrumentId: i, unitsMajor: 5, unitCostMajor: 1500, tradeDate: "2026-01-01" });
  await addFx("JPY", "2026-01-01", 0.0067);              // 1 JPY = 0.0067 USD

  const v = await holdingsAccountValuation(acc, undefined, "USD");
  // mv ¥10000 -> $67.00 ; cost ¥7500 -> $50.25 ; gain $16.75
  expect(v.baseMinor).toBe(6700);
  expect(v.gainBaseMinor).toBe(1675);
  expect(v.missing).toBe(false);
});

test("holdingsAccountValuation: missing price flags + excludes the lot", async () => {
  const acc = await addHoldingsAccount("USD");
  const i = await addInstrument({ currency: "USD" });
  await addLot({ accountId: acc, instrumentId: i, unitsMajor: 10, unitCostMajor: 100, tradeDate: "2026-01-01" }); // no price

  const v = await holdingsAccountValuation(acc, undefined, "USD");
  expect(v.baseMinor).toBe(0);
  expect(v.missing).toBe(true);
  expect(v.lots[0].missingPrice).toBe(true);
});

test("holdingsAccountValuation: a lot with trade_date after asOf is excluded", async () => {
  const acc = await addHoldingsAccount("USD");
  const i = await addInstrument({ currency: "USD" });
  await addPrice(i, "2026-01-01", 100);
  await addLot({ accountId: acc, instrumentId: i, unitsMajor: 10, unitCostMajor: 100, tradeDate: "2026-06-01" });

  const before = await holdingsAccountValuation(acc, "2026-03-01", "USD");
  expect(before.lots.length).toBe(0);
  expect(before.baseMinor).toBe(0);
  const after = await holdingsAccountValuation(acc, "2026-06-01", "USD");
  expect(after.lots.length).toBe(1);
  expect(after.baseMinor).toBe(100000); // 10 * 100
});

test("holdingsAccountValuation: missing FX rate (non-base instrument) flags + excludes", async () => {
  const acc = await addHoldingsAccount("USD");
  const i = await addInstrument({ currency: "EUR" });
  await addPrice(i, "2026-01-01", 50);
  await addLot({ accountId: acc, instrumentId: i, unitsMajor: 2, unitCostMajor: 40, tradeDate: "2026-01-01" }); // no EUR fx

  const v = await holdingsAccountValuation(acc, undefined, "USD");
  expect(v.baseMinor).toBe(0);
  expect(v.missing).toBe(true);
  expect(v.lots[0].missingPrice).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/aziz/Workspace/uang/apps/api && bun test src/lib/holdings.test.ts`
Expected: FAIL — `holdingsAccountValuation` is not exported.

- [ ] **Step 3: Implement**

In `apps/api/src/lib/holdings.ts`:

Extend the imports:
```ts
import { db } from "../db/client";
import { prices, lots, instruments } from "../db/schema";
import { and, eq, lte, desc } from "drizzle-orm";
import { SCALE, roundDiv, toBig, fromBig, convertToBase, currencyDecimals } from "@uang/shared";
import { latestFxRateScaled } from "./fx";
```

Add these types + function at the end of the file:
```ts
export type HoldingLot = {
  lotId: string; instrumentId: string;
  instrument: { id: string; symbol: string | null; name: string; kind: string; currency: string };
  unitsScaled: number; unitCostScaled: number; feesMinor: number; tradeDate: string; note: string | null;
  priceScaled: number | null;
  mvMinor: number; costMinor: number; gainMinor: number; // instrument currency
  instrumentCurrency: string;
  mvBaseMinor: number; gainBaseMinor: number; // base currency
  missingPrice: boolean; // true if no price OR no FX rate -> excluded from totals
};

export type HoldingsValuation = {
  baseMinor: number; gainBaseMinor: number; missing: boolean; lots: HoldingLot[];
};

// Value every lot in an account (with trade_date <= asOf) using carry-forward prices,
// converting each lot's market value & gain from the instrument's currency to `base`.
// A missing price or missing FX rate flags the account and excludes that lot from totals.
export async function holdingsAccountValuation(accountId: string, asOf: string | undefined, base: string): Promise<HoldingsValuation> {
  const rows = await db
    .select()
    .from(lots)
    .innerJoin(instruments, eq(lots.instrumentId, instruments.id))
    .where(eq(lots.accountId, accountId));

  let totalBase = 0n;
  let totalGainBase = 0n;
  let missing = false;
  const out: HoldingLot[] = [];

  for (const row of rows) {
    const lot = row.lots;
    const instr = row.instruments;
    if (asOf && lot.tradeDate > asOf) continue; // not yet held as of the date

    const priceScaled = await instrumentPriceScaled(lot.instrumentId, asOf);
    const instrDec = currencyDecimals(instr.currency);

    let mvMinor = 0, costMinor = 0, gainMinor = 0;
    let mvBaseMinor = 0, gainBaseMinor = 0;
    let missingPrice = false;

    if (priceScaled === null) {
      missingPrice = true;
    } else {
      const v = lotValuation(
        { unitsScaled: lot.unitsScaled, unitCostScaled: lot.unitCostScaled, feesMinor: lot.feesMinor },
        priceScaled, instrDec,
      );
      mvMinor = v.mvMinor; costMinor = v.costMinor; gainMinor = v.gainMinor;

      if (instr.currency.toUpperCase() === base.toUpperCase()) {
        mvBaseMinor = mvMinor; gainBaseMinor = gainMinor;
      } else {
        const rate = await latestFxRateScaled(instr.currency, asOf);
        if (rate === null) {
          missingPrice = true; // no way to express in base -> treat like a missing price
        } else {
          mvBaseMinor = fromBig(convertToBase(toBig(mvMinor), instr.currency, base, toBig(rate)));
          gainBaseMinor = fromBig(convertToBase(toBig(gainMinor), instr.currency, base, toBig(rate)));
        }
      }
    }

    if (missingPrice) {
      missing = true;
    } else {
      totalBase += toBig(mvBaseMinor);
      totalGainBase += toBig(gainBaseMinor);
    }

    out.push({
      lotId: lot.id, instrumentId: lot.instrumentId,
      instrument: { id: instr.id, symbol: instr.symbol, name: instr.name, kind: instr.kind, currency: instr.currency },
      unitsScaled: lot.unitsScaled, unitCostScaled: lot.unitCostScaled, feesMinor: lot.feesMinor,
      tradeDate: lot.tradeDate, note: lot.note,
      priceScaled,
      mvMinor, costMinor, gainMinor,
      instrumentCurrency: instr.currency,
      mvBaseMinor, gainBaseMinor,
      missingPrice,
    });
  }

  return { baseMinor: fromBig(totalBase), gainBaseMinor: fromBig(totalGainBase), missing, lots: out };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /Users/aziz/Workspace/uang/apps/api && bun test src/lib/holdings.test.ts`
Expected: PASS (9 tests total).

- [ ] **Step 5: Commit**

```bash
cd /Users/aziz/Workspace/uang && git add apps/api/src/lib/holdings.ts apps/api/src/lib/holdings.test.ts && git commit -m "feat(api): holdingsAccountValuation (carry-forward price, instrument->base FX, flags)"
```

---

## Task 4: Integrate holdings into `netWorth`

**Files:**
- Modify: `apps/api/src/lib/valuation.ts`
- Modify: `apps/api/src/lib/valuation.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/lib/valuation.test.ts`.

Extend the schema import — change:
```ts
import { settings, accounts, entries, fxRates, accountOwners } from "../db/schema";
```
to:
```ts
import { settings, accounts, entries, fxRates, accountOwners, instruments, lots, prices } from "../db/schema";
```

Add helpers after the existing `setOwnersDirect` helper:
```ts
async function addHoldingsAccount(name: string) {
  const id = createId();
  await db.insert(accounts).values({
    id, name, class: "asset", subtype: "investment", currency: "USD",
    valuationMode: "holdings", isArchived: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy: "u",
  });
  return id;
}
async function addInstrument(currency: string) {
  const id = createId();
  await db.insert(instruments).values({ id, symbol: "X", isin: null, name: "X", kind: "stock", currency, createdAt: nowEpoch() });
  return id;
}
async function addPrice(instrumentId: string, date: string, priceMajor: number) {
  await db.insert(prices).values({ id: createId(), instrumentId, date, priceScaled: Math.round(priceMajor * Number(SCALE)), source: "manual", createdAt: nowEpoch() });
}
async function addLot(accountId: string, instrumentId: string, unitsMajor: number, costMajor: number, tradeDate: string) {
  await db.insert(lots).values({
    id: createId(), accountId, instrumentId,
    unitsScaled: Math.round(unitsMajor * Number(SCALE)), unitCostScaled: Math.round(costMajor * Number(SCALE)),
    feesMinor: 0, tradeDate, note: null, createdAt: nowEpoch(), createdBy: "u",
  });
}
```
(`SCALE` is already imported in valuation.test.ts via `netWorth`? No — import it.) Ensure the top imports include `SCALE`: change `import { accountBalanceMinor, netWorth } from "./valuation";` to also import SCALE from shared — add a line:
```ts
import { SCALE } from "@uang/shared";
```

Append these tests:
```ts
test("netWorth values a holdings account and sums it with ledger accounts", async () => {
  await seedBase("USD");
  // ledger: $1,000.00
  const cash = await addAccount({ name: "Cash", cls: "asset", currency: "USD" });
  await addEntry(cash, 100000, "2026-01-01");
  // holdings: 10 units @ $50 = $500.00
  const broker = await addHoldingsAccount("Broker");
  const inst = await addInstrument("USD");
  await addPrice(inst, "2026-01-01", 50);
  await addLot(broker, inst, 10, 40, "2026-01-01");

  const nw = await netWorth();
  expect(nw.totalBaseMinor).toBe(150000); // 100000 + 50000
  const b = nw.accounts.find((a) => a.name === "Broker")!;
  expect(b.baseMinor).toBe(50000);
  expect(b.balanceMinor).toBe(50000); // holdings: balanceMinor == base total
  expect(b.currency).toBe("USD");      // holdings report in base currency
  expect(b.missingRate).toBe(false);
});

test("netWorth holdings respects asOf (price added later does not affect earlier date)", async () => {
  await seedBase("USD");
  const broker = await addHoldingsAccount("Broker");
  const inst = await addInstrument("USD");
  await addPrice(inst, "2026-05-01", 50);
  await addLot(broker, inst, 10, 40, "2026-01-01");

  expect((await netWorth({ asOf: "2026-03-01" })).totalBaseMinor).toBe(0); // no price <= asOf -> excluded
  expect((await netWorth({ asOf: "2026-05-01" })).totalBaseMinor).toBe(50000);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/aziz/Workspace/uang/apps/api && bun test src/lib/valuation.test.ts`
Expected: FAIL — `netWorth` doesn't yet branch on holdings (Broker valued as 0 ledger; `totalBaseMinor` is 100000, not 150000).

- [ ] **Step 3: Implement the holdings branch**

In `apps/api/src/lib/valuation.ts`:

Add the import (after the `./fx` import):
```ts
import { holdingsAccountValuation } from "./holdings";
```

In `netWorth`, inside the `for (const a of accts)` loop, replace the body that computes `balanceMinor`/`baseMinor`/`missingRate` so holdings accounts use the holdings engine. The loop currently (after the owner-filter `continue`) computes ledger values. Change it to branch on `a.valuationMode`:

```ts
    let balanceMinor = 0;
    let baseMinor = 0;
    let missingRate = false;
    let currency = a.currency;

    if (a.valuationMode === "holdings") {
      const hv = await holdingsAccountValuation(a.id, asOf, base);
      baseMinor = hv.baseMinor;
      balanceMinor = hv.baseMinor; // holdings: own-currency balance == base total (display rule)
      missingRate = hv.missing;
      currency = base;             // holdings report in base currency
    } else {
      balanceMinor = await accountBalanceMinor(a.id, asOf);
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
    }
    if (!missingRate) total += toBig(baseMinor);
    out.push({
      id: a.id, name: a.name, class: a.class, subtype: a.subtype, currency,
      balanceMinor, baseMinor, missingRate, ownerIds, shared,
    });
```

(Note: `currency` now comes from the local variable, not `a.currency`, so holdings rows report `base`. Make sure the previously-existing ledger code block that computed these values is fully replaced by the block above — there should be no leftover duplicate `const balanceMinor = await accountBalanceMinor(...)` below it.)

- [ ] **Step 4: Run to verify all valuation tests pass**

Run: `cd /Users/aziz/Workspace/uang/apps/api && bun test src/lib/valuation.test.ts`
Expected: PASS — all existing tests (ledger, FX, owners) plus the 2 new holdings tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/aziz/Workspace/uang && git add apps/api/src/lib/valuation.ts apps/api/src/lib/valuation.test.ts && git commit -m "feat(api): netWorth values holdings accounts (as-of-aware)"
```

---

## Task 5: Allow holdings account creation

**Files:**
- Modify: `apps/api/src/routes/accounts.ts`
- Modify: `apps/api/src/routes/accounts.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/routes/accounts.test.ts`:

```ts
test("creates a holdings account (valuationMode='holdings')", async () => {
  const app = makeApp(accountsRoutes);
  const { cookie } = await initAndLogin({ app });

  const res = await app.handle(new Request("http://localhost/accounts", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Broker", class: "asset", subtype: "investment", currency: "USD", valuationMode: "holdings" }),
  }));
  expect(res.status).toBe(200);

  const list = await (await app.handle(new Request("http://localhost/accounts", { headers: { cookie } }))).json();
  const broker = list.find((a: any) => a.name === "Broker");
  expect(broker.valuationMode).toBe("holdings");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/aziz/Workspace/uang/apps/api && bun test src/routes/accounts.test.ts`
Expected: FAIL — currently the route returns 400 `holdings_not_supported_in_v2`.

- [ ] **Step 3: Implement**

In `apps/api/src/routes/accounts.ts`, in the `POST "/"` handler, REMOVE the rejection block:
```ts
      if ((body.valuationMode ?? "ledger") !== "ledger") {
        set.status = 400;
        return { error: "holdings_not_supported_in_v2" };
      }
```

Then change the account insert so `valuationMode` honors the body (defaulting to `"ledger"`). In the `db.insert(accounts).values({ ... })`, change:
```ts
        valuationMode: "ledger",
```
to:
```ts
        valuationMode: body.valuationMode === "holdings" ? "holdings" : "ledger",
```

(The opening-balance block below stays as-is: a holdings account simply won't send `openingBalanceMinor`, so no opening entry is created. The `ownerIds` logic is unchanged.)

- [ ] **Step 4: Run to verify the tests pass**

Run: `cd /Users/aziz/Workspace/uang/apps/api && bun test src/routes/accounts.test.ts`
Expected: PASS — the new holdings-create test plus all existing accounts tests (the "rejects holdings valuation mode in v2" test must be UPDATED — see next step).

- [ ] **Step 5: Update the now-obsolete rejection test**

The existing test `"rejects holdings valuation mode in v2"` asserts a 400. That behavior is intentionally gone. Replace that test body so it asserts holdings is now accepted. Find:
```ts
test("rejects holdings valuation mode in v2", async () => {
```
and replace the entire test with:
```ts
test("accepts holdings valuation mode", async () => {
  const app = makeApp(accountsRoutes);
  const { cookie } = await initAndLogin({ app });

  const res = await app.handle(
    new Request("http://localhost/accounts", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        name: "Broker",
        class: "asset",
        subtype: "investment",
        currency: "USD",
        valuationMode: "holdings",
      }),
    }),
  );
  expect(res.status).toBe(200);
});
```

- [ ] **Step 6: Run the accounts suite again**

Run: `cd /Users/aziz/Workspace/uang/apps/api && bun test src/routes/accounts.test.ts`
Expected: PASS — all green.

- [ ] **Step 7: Commit**

```bash
cd /Users/aziz/Workspace/uang && git add apps/api/src/routes/accounts.ts apps/api/src/routes/accounts.test.ts && git commit -m "feat(api): allow holdings-mode account creation"
```

---

## Task 6: Instruments routes

**Files:**
- Create: `apps/api/src/routes/instruments.ts`
- Create: `apps/api/src/routes/instruments.test.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/instruments.test.ts`:

```ts
import { expect, test, beforeEach } from "bun:test";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { instrumentsRoutes } from "./instruments";

beforeEach(resetDb);

test("requires auth", async () => {
  const app = makeApp(instrumentsRoutes);
  const res = await app.handle(new Request("http://localhost/instruments"));
  expect(res.status).toBe(401);
});

test("create then list instruments", async () => {
  const app = makeApp(instrumentsRoutes);
  const { cookie } = await initAndLogin({ app });

  const create = await app.handle(new Request("http://localhost/instruments", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Apple", kind: "stock", currency: "usd", symbol: "AAPL" }),
  }));
  expect(create.status).toBe(200);
  const { id } = await create.json();
  expect(id).toBeTruthy();

  const list = await (await app.handle(new Request("http://localhost/instruments", { headers: { cookie } }))).json();
  expect(list.length).toBe(1);
  expect(list[0].name).toBe("Apple");
  expect(list[0].symbol).toBe("AAPL");
  expect(list[0].currency).toBe("USD"); // uppercased
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/aziz/Workspace/uang/apps/api && bun test src/routes/instruments.test.ts`
Expected: FAIL — `Cannot find module './instruments'`.

- [ ] **Step 3: Implement**

Create `apps/api/src/routes/instruments.ts`:

```ts
import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { instruments } from "../db/schema";
import { authGuard } from "../lib/auth-guard";
import { createId, nowEpoch } from "../lib/ids";

export const instrumentsRoutes = new Elysia({ prefix: "/instruments" })
  .use(authGuard)
  .get("/", async () => db.select().from(instruments).orderBy(instruments.name))
  .post(
    "/",
    async ({ body }: any) => {
      const id = createId();
      await db.insert(instruments).values({
        id,
        symbol: body.symbol ?? null,
        isin: body.isin ?? null,
        name: body.name,
        kind: body.kind,
        currency: body.currency.toUpperCase(),
        createdAt: nowEpoch(),
      });
      return { id };
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1 }),
        kind: t.Union([t.Literal("stock"), t.Literal("etf"), t.Literal("fund"), t.Literal("other")]),
        currency: t.String({ pattern: "^[A-Za-z]{3}$" }),
        symbol: t.Optional(t.String()),
        isin: t.Optional(t.String()),
      }),
    },
  );
```

- [ ] **Step 4: Mount the route**

In `apps/api/src/app.ts`, add the import alongside the other route imports:
```ts
import { instrumentsRoutes } from "./routes/instruments";
```
and add `.use(instrumentsRoutes)` to the chain (next to `.use(accountsRoutes)`):
```ts
    .use(instrumentsRoutes)
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd /Users/aziz/Workspace/uang/apps/api && bun test src/routes/instruments.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
cd /Users/aziz/Workspace/uang && git add apps/api/src/routes/instruments.ts apps/api/src/routes/instruments.test.ts apps/api/src/app.ts && git commit -m "feat(api): instruments routes (list/create)"
```

---

## Task 7: Lots routes + holdings payload

**Files:**
- Create: `apps/api/src/routes/lots.ts`
- Create: `apps/api/src/routes/lots.test.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/lots.test.ts`:

```ts
import { expect, test, beforeEach } from "bun:test";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { lotsRoutes } from "./lots";
import { db } from "../db/client";
import { instruments, accounts, prices } from "../db/schema";
import { createId, nowEpoch } from "../lib/ids";

const SCALE = 100_000_000;
beforeEach(resetDb);

async function seedInstrument(currency = "USD") {
  const id = createId();
  await db.insert(instruments).values({ id, symbol: "X", isin: null, name: "X", kind: "stock", currency, createdAt: nowEpoch() });
  return id;
}
async function seedHoldingsAccount() {
  const id = createId();
  await db.insert(accounts).values({
    id, name: "Broker", class: "asset", subtype: "investment", currency: "USD",
    valuationMode: "holdings", isArchived: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy: "seed",
  });
  return id;
}
async function seedPrice(instrumentId: string, date: string, priceMajor: number) {
  await db.insert(prices).values({ id: createId(), instrumentId, date, priceScaled: Math.round(priceMajor * SCALE), source: "manual", createdAt: nowEpoch() });
}

test("requires auth", async () => {
  const app = makeApp(lotsRoutes);
  const res = await app.handle(new Request("http://localhost/accounts/x/lots"));
  expect(res.status).toBe(401);
});

test("add, list, then delete a lot", async () => {
  const app = makeApp(lotsRoutes);
  const { cookie } = await initAndLogin({ app });
  const acc = await seedHoldingsAccount();
  const inst = await seedInstrument();

  const add = await app.handle(new Request(`http://localhost/accounts/${acc}/lots`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ instrumentId: inst, unitsScaled: 10 * SCALE, unitCostScaled: 100 * SCALE, feesMinor: 500, tradeDate: "2026-01-01" }),
  }));
  expect(add.status).toBe(200);
  const { id: lotId } = await add.json();

  const list = await (await app.handle(new Request(`http://localhost/accounts/${acc}/lots`, { headers: { cookie } }))).json();
  expect(list.length).toBe(1);
  expect(list[0].instrumentId).toBe(inst);

  const del = await app.handle(new Request(`http://localhost/lots/${lotId}`, { method: "DELETE", headers: { cookie } }));
  expect(del.status).toBe(200);
  const after = await (await app.handle(new Request(`http://localhost/accounts/${acc}/lots`, { headers: { cookie } }))).json();
  expect(after.length).toBe(0);
});

test("add a lot with an unknown instrument is rejected (422)", async () => {
  const app = makeApp(lotsRoutes);
  const { cookie } = await initAndLogin({ app });
  const acc = await seedHoldingsAccount();

  const add = await app.handle(new Request(`http://localhost/accounts/${acc}/lots`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ instrumentId: "ghost", unitsScaled: SCALE, unitCostScaled: SCALE, tradeDate: "2026-01-01" }),
  }));
  expect(add.status).toBe(422);
});

test("PATCH a lot updates units", async () => {
  const app = makeApp(lotsRoutes);
  const { cookie } = await initAndLogin({ app });
  const acc = await seedHoldingsAccount();
  const inst = await seedInstrument();
  const { id: lotId } = await (await app.handle(new Request(`http://localhost/accounts/${acc}/lots`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ instrumentId: inst, unitsScaled: 10 * SCALE, unitCostScaled: 100 * SCALE, tradeDate: "2026-01-01" }),
  }))).json();

  const patch = await app.handle(new Request(`http://localhost/lots/${lotId}`, {
    method: "PATCH", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ unitsScaled: 20 * SCALE }),
  }));
  expect(patch.status).toBe(200);
  const list = await (await app.handle(new Request(`http://localhost/accounts/${acc}/lots`, { headers: { cookie } }))).json();
  expect(list[0].unitsScaled).toBe(20 * SCALE);
});

test("GET /accounts/:id/holdings returns per-lot valuation + totals", async () => {
  const app = makeApp(lotsRoutes);
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const acc = await seedHoldingsAccount();
  const inst = await seedInstrument("USD");
  await seedPrice(inst, "2026-01-01", 123.45);
  await app.handle(new Request(`http://localhost/accounts/${acc}/lots`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ instrumentId: inst, unitsScaled: 10 * SCALE, unitCostScaled: 100 * SCALE, feesMinor: 500, tradeDate: "2026-01-01" }),
  }));

  const res = await app.handle(new Request(`http://localhost/accounts/${acc}/holdings`, { headers: { cookie } }));
  expect(res.status).toBe(200);
  const h = await res.json();
  expect(h.totalBaseMinor).toBe(123450);
  expect(h.totalGainBaseMinor).toBe(22950);
  expect(h.baseCurrency).toBe("USD");
  expect(h.lots.length).toBe(1);
  expect(h.lots[0].mvMinor).toBe(123450);
  expect(h.lots[0].instrumentCurrency).toBe("USD");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/aziz/Workspace/uang/apps/api && bun test src/routes/lots.test.ts`
Expected: FAIL — `Cannot find module './lots'`.

- [ ] **Step 3: Implement**

Create `apps/api/src/routes/lots.ts`:

```ts
import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { lots, instruments, settings } from "../db/schema";
import { eq } from "drizzle-orm";
import { authGuard } from "../lib/auth-guard";
import { createId, nowEpoch } from "../lib/ids";
import { holdingsAccountValuation } from "../lib/holdings";

export const lotsRoutes = new Elysia()
  .use(authGuard)
  // List raw lots for an account
  .get("/accounts/:id/lots", async ({ params }) =>
    db.select().from(lots).where(eq(lots.accountId, params.id)).orderBy(lots.tradeDate),
  )
  // Add a lot (instrument must exist)
  .post(
    "/accounts/:id/lots",
    async ({ params, body, userId, set }: any) => {
      const instr = await db.select({ id: instruments.id }).from(instruments).where(eq(instruments.id, body.instrumentId));
      if (instr.length === 0) {
        set.status = 422;
        return { error: "unknown_instrument" };
      }
      const id = createId();
      await db.insert(lots).values({
        id,
        accountId: params.id,
        instrumentId: body.instrumentId,
        unitsScaled: body.unitsScaled,
        unitCostScaled: body.unitCostScaled,
        feesMinor: body.feesMinor ?? 0,
        tradeDate: body.tradeDate,
        note: body.note ?? null,
        createdAt: nowEpoch(),
        createdBy: userId!,
      });
      return { id };
    },
    {
      body: t.Object({
        instrumentId: t.String(),
        unitsScaled: t.Number(),
        unitCostScaled: t.Number(),
        feesMinor: t.Optional(t.Number()),
        tradeDate: t.String(),
        note: t.Optional(t.String()),
      }),
    },
  )
  // Edit a lot
  .patch(
    "/lots/:id",
    async ({ params, body }: any) => {
      const update: Record<string, unknown> = {};
      if (body.instrumentId !== undefined) update.instrumentId = body.instrumentId;
      if (body.unitsScaled !== undefined) update.unitsScaled = body.unitsScaled;
      if (body.unitCostScaled !== undefined) update.unitCostScaled = body.unitCostScaled;
      if (body.feesMinor !== undefined) update.feesMinor = body.feesMinor;
      if (body.tradeDate !== undefined) update.tradeDate = body.tradeDate;
      if (body.note !== undefined) update.note = body.note;
      await db.update(lots).set(update).where(eq(lots.id, params.id));
      return { ok: true };
    },
    {
      body: t.Object({
        instrumentId: t.Optional(t.String()),
        unitsScaled: t.Optional(t.Number()),
        unitCostScaled: t.Optional(t.Number()),
        feesMinor: t.Optional(t.Number()),
        tradeDate: t.Optional(t.String()),
        note: t.Optional(t.String()),
      }),
    },
  )
  // Delete a lot
  .delete("/lots/:id", async ({ params }) => {
    await db.delete(lots).where(eq(lots.id, params.id));
    return { ok: true };
  })
  // Server-computed holdings payload for the detail page (current value, no asOf)
  .get("/accounts/:id/holdings", async ({ params }) => {
    const s = (await db.select().from(settings).where(eq(settings.id, 1)))[0];
    const base = s?.baseCurrency ?? "USD";
    const v = await holdingsAccountValuation(params.id, undefined, base);
    return { baseCurrency: base, totalBaseMinor: v.baseMinor, totalGainBaseMinor: v.gainBaseMinor, missing: v.missing, lots: v.lots };
  });
```

- [ ] **Step 4: Mount the route**

In `apps/api/src/app.ts`, add the import:
```ts
import { lotsRoutes } from "./routes/lots";
```
and add `.use(lotsRoutes)` to the chain (next to `.use(entriesRoutes)`):
```ts
    .use(lotsRoutes)
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd /Users/aziz/Workspace/uang/apps/api && bun test src/routes/lots.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
cd /Users/aziz/Workspace/uang && git add apps/api/src/routes/lots.ts apps/api/src/routes/lots.test.ts apps/api/src/app.ts && git commit -m "feat(api): lots routes (CRUD) + GET /accounts/:id/holdings payload"
```

---

## Task 8: Prices routes

**Files:**
- Create: `apps/api/src/routes/prices.ts`
- Create: `apps/api/src/routes/prices.test.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/prices.test.ts`:

```ts
import { expect, test, beforeEach } from "bun:test";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { pricesRoutes } from "./prices";
import { db } from "../db/client";
import { instruments } from "../db/schema";
import { createId, nowEpoch } from "../lib/ids";

const SCALE = 100_000_000;
beforeEach(resetDb);

async function seedInstrument() {
  const id = createId();
  await db.insert(instruments).values({ id, symbol: "X", isin: null, name: "X", kind: "stock", currency: "USD", createdAt: nowEpoch() });
  return id;
}

test("requires auth", async () => {
  const app = makeApp(pricesRoutes);
  const res = await app.handle(new Request("http://localhost/instruments/x/prices"));
  expect(res.status).toBe(401);
});

test("add a price, list it, upsert same date, then delete", async () => {
  const app = makeApp(pricesRoutes);
  const { cookie } = await initAndLogin({ app });
  const inst = await seedInstrument();

  const add = await app.handle(new Request(`http://localhost/instruments/${inst}/prices`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ date: "2026-01-01", priceScaled: 100 * SCALE }),
  }));
  expect(add.status).toBe(200);

  // upsert: same instrument+date with a new price replaces, not duplicates
  const upsert = await app.handle(new Request(`http://localhost/instruments/${inst}/prices`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ date: "2026-01-01", priceScaled: 120 * SCALE }),
  }));
  expect(upsert.status).toBe(200);

  const list = await (await app.handle(new Request(`http://localhost/instruments/${inst}/prices`, { headers: { cookie } }))).json();
  expect(list.length).toBe(1);
  expect(list[0].priceScaled).toBe(120 * SCALE);

  const del = await app.handle(new Request(`http://localhost/prices/${list[0].id}`, { method: "DELETE", headers: { cookie } }));
  expect(del.status).toBe(200);
  const after = await (await app.handle(new Request(`http://localhost/instruments/${inst}/prices`, { headers: { cookie } }))).json();
  expect(after.length).toBe(0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/aziz/Workspace/uang/apps/api && bun test src/routes/prices.test.ts`
Expected: FAIL — `Cannot find module './prices'`.

- [ ] **Step 3: Implement**

Create `apps/api/src/routes/prices.ts`:

```ts
import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { prices } from "../db/schema";
import { eq } from "drizzle-orm";
import { authGuard } from "../lib/auth-guard";
import { createId, nowEpoch } from "../lib/ids";

export const pricesRoutes = new Elysia()
  .use(authGuard)
  // List price history for an instrument (newest first)
  .get("/instruments/:id/prices", async ({ params }) =>
    db.select().from(prices).where(eq(prices.instrumentId, params.id)).orderBy(prices.date),
  )
  // Upsert a manual price for (instrument, date): replace on conflict
  .post(
    "/instruments/:id/prices",
    async ({ params, body }: any) => {
      const id = createId();
      await db
        .insert(prices)
        .values({
          id,
          instrumentId: params.id,
          date: body.date,
          priceScaled: body.priceScaled,
          source: "manual",
          createdAt: nowEpoch(),
        })
        .onConflictDoUpdate({
          target: [prices.instrumentId, prices.date],
          set: { priceScaled: body.priceScaled },
        });
      return { ok: true };
    },
    {
      body: t.Object({
        date: t.String(),
        priceScaled: t.Number(),
      }),
    },
  )
  // Delete a price point
  .delete("/prices/:id", async ({ params }) => {
    await db.delete(prices).where(eq(prices.id, params.id));
    return { ok: true };
  });
```

- [ ] **Step 4: Mount the route**

In `apps/api/src/app.ts`, add the import:
```ts
import { pricesRoutes } from "./routes/prices";
```
and add `.use(pricesRoutes)` to the chain (next to `.use(fxRoutes)`):
```ts
    .use(pricesRoutes)
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd /Users/aziz/Workspace/uang/apps/api && bun test src/routes/prices.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Run the FULL API suite (integration check)**

Run: `cd /Users/aziz/Workspace/uang/apps/api && bun test`
Expected: PASS — entire API suite green (holdings, valuation, accounts, instruments, lots, prices, plus all prior tests).

- [ ] **Step 7: Commit**

```bash
cd /Users/aziz/Workspace/uang && git add apps/api/src/routes/prices.ts apps/api/src/routes/prices.test.ts apps/api/src/app.ts && git commit -m "feat(api): prices routes (history, upsert, delete)"
```

---

## Task 9: Web data layer — instruments/lots/prices collections

**Files:**
- Modify: `apps/web/src/lib/collections.ts`

- [ ] **Step 1: Add row types + collections**

In `apps/web/src/lib/collections.ts`, add the new row types near the other types (after `EntryRow`):

```ts
export type InstrumentRow = {
  id: string;
  symbol: string | null;
  isin: string | null;
  name: string;
  kind: string;
  currency: string;
  createdAt: number;
};

export type LotRow = {
  id: string;
  accountId: string;
  instrumentId: string;
  unitsScaled: number;
  unitCostScaled: number;
  feesMinor: number;
  tradeDate: string;
  note: string | null;
  createdAt: number;
  createdBy: string;
};

export type PriceRow = {
  id: string;
  instrumentId: string;
  date: string;
  priceScaled: number;
  source: string;
  createdAt: number;
};
```

Add the global instruments collection after `fxCollection`:

```ts
export const instrumentsCollection = createCollection(
  queryCollectionOptions<InstrumentRow, Error, ["instruments"], string>({
    queryKey: ["instruments"],
    queryFn: async (): Promise<Array<InstrumentRow>> => {
      const { data, error } = await api.instruments.get();
      if (error) throw new Error(String(error));
      return (data as unknown as InstrumentRow[]) ?? [];
    },
    queryClient,
    getKey: (i) => i.id,
    onInsert: async ({ transaction }) => {
      const m = transaction.mutations[0]?.modified as InstrumentRow | undefined;
      if (!m) return;
      const { id: _id, createdAt: _ca, ...body } = m;
      await api.instruments.post(body as any);
    },
  })
);
```

Add the per-account lots collection and per-instrument prices collection after the `entriesCollection` factory:

```ts
// ---------------------------------------------------------------------------
// lotsCollection — factory, memoised per accountId
// ---------------------------------------------------------------------------

type LotsCollection = ReturnType<typeof _makeLotsCollection>;
const _lotsCache = new Map<string, LotsCollection>();

function _makeLotsCollection(accountId: string) {
  return createCollection(
    queryCollectionOptions<LotRow, Error, [string, string], string>({
      queryKey: ["lots", accountId],
      queryFn: async (): Promise<Array<LotRow>> => {
        const { data, error } = await api.accounts({ id: accountId }).lots.get();
        if (error) throw new Error(String(error));
        return (data as unknown as LotRow[]) ?? [];
      },
      queryClient,
      getKey: (l) => l.id,
      onInsert: async ({ transaction }) => {
        const m = transaction.mutations[0]?.modified as LotRow | undefined;
        if (!m) return;
        const { id: _id, accountId: _aid, createdAt: _ca, createdBy: _cb, ...body } = m;
        await api.accounts({ id: accountId }).lots.post(body as any);
      },
      onUpdate: async ({ transaction }) => {
        const m = transaction.mutations[0]?.modified as LotRow | undefined;
        if (!m) return;
        await api.lots({ id: m.id }).patch(m as any);
      },
      onDelete: async ({ transaction }) => {
        const id = (transaction.mutations[0]?.original as LotRow | undefined)?.id;
        if (!id) return;
        await api.lots({ id }).delete();
      },
    })
  );
}

export function lotsCollection(accountId: string): LotsCollection {
  if (!_lotsCache.has(accountId)) _lotsCache.set(accountId, _makeLotsCollection(accountId));
  return _lotsCache.get(accountId)!;
}

// ---------------------------------------------------------------------------
// pricesCollection — factory, memoised per instrumentId
// ---------------------------------------------------------------------------

type PricesCollection = ReturnType<typeof _makePricesCollection>;
const _pricesCache = new Map<string, PricesCollection>();

function _makePricesCollection(instrumentId: string) {
  return createCollection(
    queryCollectionOptions<PriceRow, Error, [string, string], string>({
      queryKey: ["prices", instrumentId],
      queryFn: async (): Promise<Array<PriceRow>> => {
        const { data, error } = await api.instruments({ id: instrumentId }).prices.get();
        if (error) throw new Error(String(error));
        return (data as unknown as PriceRow[]) ?? [];
      },
      queryClient,
      getKey: (p) => p.id,
      onInsert: async ({ transaction }) => {
        const m = transaction.mutations[0]?.modified as PriceRow | undefined;
        if (!m) return;
        await api.instruments({ id: instrumentId }).prices.post({ date: m.date, priceScaled: m.priceScaled } as any);
      },
      onDelete: async ({ transaction }) => {
        const id = (transaction.mutations[0]?.original as PriceRow | undefined)?.id;
        if (!id) return;
        await api.prices({ id }).delete();
      },
    })
  );
}

export function pricesCollection(instrumentId: string): PricesCollection {
  if (!_pricesCache.has(instrumentId)) _pricesCache.set(instrumentId, _makePricesCollection(instrumentId));
  return _pricesCache.get(instrumentId)!;
}
```

- [ ] **Step 2: Verify the web build compiles**

Run: `cd /Users/aziz/Workspace/uang/apps/web && bun run build`
Expected: PASS (the new collections type-check against the eden `App` type — these routes now exist on the API).

- [ ] **Step 3: Commit**

```bash
cd /Users/aziz/Workspace/uang && git add apps/web/src/lib/collections.ts && git commit -m "feat(web): instruments/lots/prices TanStack DB collections"
```

---

## Task 10: Account form — valuation-mode toggle

**Files:**
- Modify: `apps/web/src/components/account-form.tsx`

- [ ] **Step 1: Add a valuation-mode field**

In `apps/web/src/components/account-form.tsx`:

(a) Add `valuationMode` to the form state. Find the `useState({ ... })` initializer for `f` and add a `valuationMode` field:
```ts
  const [f, setF] = useState({
    name: "",
    class: "asset",
    subtype: "bank",
    currency: "USD",
    valuationMode: "ledger",
    openingBalance: "",
    openingDate: new Date().toISOString().slice(0, 10),
  });
```

(b) When the subtype changes to `investment`, default the mode to `holdings` (and back to `ledger` otherwise) — but let the user override. Replace the subtype `Select`'s `onValueChange` so it also adjusts the mode. Find the subtype Select:
```tsx
              <Select
                value={f.subtype}
                onValueChange={(v: string | null) => v && set("subtype", v)}
              >
```
and change its `onValueChange` to:
```tsx
              <Select
                value={f.subtype}
                onValueChange={(v: string | null) => {
                  if (!v) return;
                  setF((prev) => ({
                    ...prev,
                    subtype: v,
                    valuationMode: v === "investment" ? "holdings" : "ledger",
                  }));
                }}
              >
```

(c) Add a Valuation-mode Select. Insert this block right after the grid that holds Type/Category (the `<div className="grid grid-cols-2 gap-3">` containing Type and Category), before the currency/opening-balance grid:
```tsx
          <div>
            <Label>Valuation</Label>
            <Select
              value={f.valuationMode}
              onValueChange={(v: string | null) => v && set("valuationMode", v)}
            >
              <SelectTrigger className="w-full">
                <SelectValue>
                  {(v: unknown) => (String(v) === "holdings" ? "Holdings (investments)" : "Ledger (balance)")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ledger">Ledger (balance)</SelectItem>
                <SelectItem value="holdings">Holdings (investments)</SelectItem>
              </SelectContent>
            </Select>
          </div>
```

(d) Hide the opening-balance fields when holdings. Wrap the currency/opening-balance grid and the opening-date `<div>` so opening inputs only show for ledger. Find the grid:
```tsx
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Currency</Label>
              <Input
                value={f.currency}
                maxLength={3}
                onChange={(e) => set("currency", e.target.value)}
                required
              />
            </div>
            <div>
              <Label>Opening balance</Label>
              <Input
                type="number"
                step="any"
                value={f.openingBalance}
                onChange={(e) => set("openingBalance", e.target.value)}
                placeholder="optional"
              />
            </div>
          </div>
          <div>
            <Label>Opening date</Label>
            <Input
              type="date"
              value={f.openingDate}
              onChange={(e) => set("openingDate", e.target.value)}
            />
          </div>
```
and replace it with (currency always shown; opening fields only for ledger):
```tsx
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Currency</Label>
              <Input
                value={f.currency}
                maxLength={3}
                onChange={(e) => set("currency", e.target.value)}
                required
              />
            </div>
            {f.valuationMode === "ledger" && (
              <div>
                <Label>Opening balance</Label>
                <Input
                  type="number"
                  step="any"
                  value={f.openingBalance}
                  onChange={(e) => set("openingBalance", e.target.value)}
                  placeholder="optional"
                />
              </div>
            )}
          </div>
          {f.valuationMode === "ledger" && (
            <div>
              <Label>Opening date</Label>
              <Input
                type="date"
                value={f.openingDate}
                onChange={(e) => set("openingDate", e.target.value)}
              />
            </div>
          )}
```

(e) Send `valuationMode` in the create body and skip opening balance for holdings. In `submit`, find the `body` construction and add `valuationMode`; guard the opening-balance block. Change:
```ts
    const body: Record<string, unknown> = {
      name: f.name,
      class: f.class,
      subtype: f.subtype,
      currency,
      ownerIds: owners.length > 0 ? owners : meId ? [meId] : [],
    };
    if (!Number.isNaN(openingMajor) && openingMajor !== 0) {
      const dec = currencyDecimals(currency);
      body.openingBalanceMinor = Math.round(openingMajor * 10 ** dec);
      body.openingDate = f.openingDate;
    }
```
to:
```ts
    const body: Record<string, unknown> = {
      name: f.name,
      class: f.class,
      subtype: f.subtype,
      currency,
      valuationMode: f.valuationMode,
      ownerIds: owners.length > 0 ? owners : meId ? [meId] : [],
    };
    if (f.valuationMode === "ledger" && !Number.isNaN(openingMajor) && openingMajor !== 0) {
      const dec = currencyDecimals(currency);
      body.openingBalanceMinor = Math.round(openingMajor * 10 ** dec);
      body.openingDate = f.openingDate;
    }
```

- [ ] **Step 2: Verify the build compiles**

Run: `cd /Users/aziz/Workspace/uang/apps/web && bun run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
cd /Users/aziz/Workspace/uang && git add apps/web/src/components/account-form.tsx && git commit -m "feat(web): valuation-mode toggle on the account form"
```

---

## Task 11: Add-lot dialog (with inline instrument create)

**Files:**
- Create: `apps/web/src/components/add-lot-dialog.tsx`

- [ ] **Step 1: Create the dialog**

Create `apps/web/src/components/add-lot-dialog.tsx`:

```tsx
import { useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { useQueryClient } from "@tanstack/react-query";
import { SCALE, currencyDecimals } from "@uang/shared";
import { instrumentsCollection, lotsCollection } from "@/lib/collections";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const NEW = "__new__";

export function AddLotDialog({ accountId }: { accountId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data: instruments } = useLiveQuery(instrumentsCollection);
  const [instrumentId, setInstrumentId] = useState<string>(NEW);
  const [ni, setNi] = useState({ name: "", symbol: "", currency: "USD", kind: "stock" });
  const [f, setF] = useState({ units: "", unitCost: "", fees: "", tradeDate: new Date().toISOString().slice(0, 10), note: "" });
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));

  // The instrument currency drives fees minor-unit scaling.
  const selectedCurrency =
    instrumentId === NEW ? ni.currency : (instruments ?? []).find((i) => i.id === instrumentId)?.currency ?? "USD";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // Create the instrument first if needed.
    let id = instrumentId;
    if (instrumentId === NEW) {
      const { data, error } = await api.instruments.post({
        name: ni.name,
        kind: ni.kind as any,
        currency: ni.currency.toUpperCase(),
        symbol: ni.symbol || undefined,
      });
      if (error) throw new Error(String(error));
      id = (data as any).id;
      await instrumentsCollection.utils.refetch();
    }
    const units = parseFloat(f.units);
    const unitCost = parseFloat(f.unitCost);
    const fees = parseFloat(f.fees);
    const dec = currencyDecimals(selectedCurrency.toUpperCase());
    await lotsCollection(accountId).insert({
      instrumentId: id,
      unitsScaled: Math.round(units * Number(SCALE)),
      unitCostScaled: Math.round(unitCost * Number(SCALE)),
      feesMinor: Number.isNaN(fees) ? 0 : Math.round(fees * 10 ** dec),
      tradeDate: f.tradeDate,
      note: f.note || null,
    } as any);
    await qc.invalidateQueries({ queryKey: ["holdings", accountId] });
    await qc.invalidateQueries({ queryKey: ["networth"] });
    setOpen(false);
    setF({ units: "", unitCost: "", fees: "", tradeDate: new Date().toISOString().slice(0, 10), note: "" });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>Add lot</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add lot</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <Label>Instrument</Label>
            <Select value={instrumentId} onValueChange={(v: string | null) => v && setInstrumentId(v)}>
              <SelectTrigger className="w-full">
                <SelectValue>
                  {(v: unknown) =>
                    String(v) === NEW
                      ? "New instrument…"
                      : (instruments ?? []).find((i) => i.id === String(v))?.name ?? "Select"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NEW}>New instrument…</SelectItem>
                {(instruments ?? []).map((i) => (
                  <SelectItem key={i.id} value={i.id}>
                    {i.symbol ? `${i.symbol} — ${i.name}` : i.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {instrumentId === NEW && (
            <div className="grid grid-cols-2 gap-3 rounded-lg border border-border p-3">
              <div className="col-span-2">
                <Label>Name</Label>
                <Input value={ni.name} onChange={(e) => setNi((p) => ({ ...p, name: e.target.value }))} required />
              </div>
              <div>
                <Label>Symbol</Label>
                <Input value={ni.symbol} onChange={(e) => setNi((p) => ({ ...p, symbol: e.target.value }))} placeholder="optional" />
              </div>
              <div>
                <Label>Currency</Label>
                <Input value={ni.currency} maxLength={3} onChange={(e) => setNi((p) => ({ ...p, currency: e.target.value }))} required />
              </div>
              <div className="col-span-2">
                <Label>Kind</Label>
                <Select value={ni.kind} onValueChange={(v: string | null) => v && setNi((p) => ({ ...p, kind: v }))}>
                  <SelectTrigger className="w-full">
                    <SelectValue>{(v: unknown) => String(v)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="stock">stock</SelectItem>
                    <SelectItem value="etf">etf</SelectItem>
                    <SelectItem value="fund">fund</SelectItem>
                    <SelectItem value="other">other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Units</Label>
              <Input type="number" step="any" value={f.units} onChange={(e) => set("units", e.target.value)} required />
            </div>
            <div>
              <Label>Unit cost ({selectedCurrency.toUpperCase()})</Label>
              <Input type="number" step="any" value={f.unitCost} onChange={(e) => set("unitCost", e.target.value)} required />
            </div>
            <div>
              <Label>Fees</Label>
              <Input type="number" step="any" value={f.fees} onChange={(e) => set("fees", e.target.value)} placeholder="optional" />
            </div>
            <div>
              <Label>Trade date</Label>
              <Input type="date" value={f.tradeDate} onChange={(e) => set("tradeDate", e.target.value)} required />
            </div>
          </div>

          <DialogFooter>
            <Button type="submit">Add</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Verify the build compiles**

Run: `cd /Users/aziz/Workspace/uang/apps/web && bun run build`
Expected: PASS.

> If `instrumentsCollection.utils.refetch()` is not the exact util name, check how `accountsCollection` exposes refetch (see how `account-detail.tsx`/`collections.ts` use `.utils`); use the equivalent. If there's no `.utils.refetch`, replace that line with `await qc.invalidateQueries({ queryKey: ["instruments"] })`.

- [ ] **Step 3: Commit**

```bash
cd /Users/aziz/Workspace/uang && git add apps/web/src/components/add-lot-dialog.tsx && git commit -m "feat(web): add-lot dialog with inline instrument create"
```

---

## Task 12: Update-price control

**Files:**
- Create: `apps/web/src/components/update-price.tsx`

- [ ] **Step 1: Create the control**

Create `apps/web/src/components/update-price.tsx`:

```tsx
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { SCALE } from "@uang/shared";
import { pricesCollection } from "@/lib/collections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

// Set a manual price for an instrument at a date (default today). Upserts per (instrument, date).
export function UpdatePrice({
  instrumentId,
  accountId,
  label,
}: {
  instrumentId: string;
  accountId: string;
  label?: string;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [price, setPrice] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const p = parseFloat(price);
    if (Number.isNaN(p)) return;
    await pricesCollection(instrumentId).insert({
      date,
      priceScaled: Math.round(p * Number(SCALE)),
    } as any);
    await qc.invalidateQueries({ queryKey: ["holdings", accountId] });
    await qc.invalidateQueries({ queryKey: ["networth"] });
    setOpen(false);
    setPrice("");
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>{label ?? "Update price"}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update price</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Price</Label>
              <Input type="number" step="any" value={price} onChange={(e) => setPrice(e.target.value)} required />
            </div>
            <div>
              <Label>As of date</Label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
            </div>
          </div>
          <DialogFooter>
            <Button type="submit">Save price</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Verify the build compiles**

Run: `cd /Users/aziz/Workspace/uang/apps/web && bun run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
cd /Users/aziz/Workspace/uang && git add apps/web/src/components/update-price.tsx && git commit -m "feat(web): update-price control (dated upsert)"
```

---

## Task 13: Holdings detail view + branch account-detail

**Files:**
- Create: `apps/web/src/components/holdings-detail.tsx`
- Modify: `apps/web/src/routes/account-detail.tsx`

- [ ] **Step 1: Create the holdings detail body**

Create `apps/web/src/components/holdings-detail.tsx`:

```tsx
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatMoney } from "@/components/money";
import { AddLotDialog } from "@/components/add-lot-dialog";
import { UpdatePrice } from "@/components/update-price";
import { Eyebrow } from "@/components/app-layout";
import { Button } from "@/components/ui/button";
import { lotsCollection } from "@/lib/collections";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type HoldingLot = {
  lotId: string;
  instrument: { id: string; symbol: string | null; name: string; kind: string; currency: string };
  unitsScaled: number;
  unitCostScaled: number;
  feesMinor: number;
  tradeDate: string;
  priceScaled: number | null;
  mvMinor: number;
  costMinor: number;
  gainMinor: number;
  instrumentCurrency: string;
  mvBaseMinor: number;
  missingPrice: boolean;
};

type Holdings = {
  baseCurrency: string;
  totalBaseMinor: number;
  totalGainBaseMinor: number;
  missing: boolean;
  lots: HoldingLot[];
};

const SCALE = 100_000_000;
const fmtUnits = (scaled: number) => String(scaled / SCALE);

export function HoldingsDetail({ accountId, accountName }: { accountId: string; accountName: string }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["holdings", accountId],
    queryFn: async (): Promise<Holdings> => {
      const { data, error } = await api.accounts({ id: accountId }).holdings.get();
      if (error) throw new Error(String(error));
      return data as unknown as Holdings;
    },
  });

  async function delLot(lotId: string) {
    await lotsCollection(accountId).delete(lotId);
    await qc.invalidateQueries({ queryKey: ["holdings", accountId] });
    await qc.invalidateQueries({ queryKey: ["networth"] });
  }

  const base = data?.baseCurrency ?? "";
  const lots = data?.lots ?? [];

  return (
    <>
      <header>
        <Eyebrow>Investments · holdings</Eyebrow>
        <h1 className="mt-2 font-heading text-3xl tracking-tight">{accountName}</h1>
        <p className="mt-1 font-heading text-4xl tabular-nums tracking-tight">
          {isLoading || !data ? "—" : formatMoney(data.totalBaseMinor, base)}
        </p>
        {data && (
          <p className={cn("mt-1 text-sm tabular-nums", data.totalGainBaseMinor < 0 ? "text-destructive" : "text-muted-foreground")}>
            {data.totalGainBaseMinor >= 0 ? "+" : ""}
            {formatMoney(data.totalGainBaseMinor, base)} unrealized
            {data.missing && <span className="ml-2 rounded-full bg-destructive/10 px-1.5 py-0.5 text-[0.65rem] font-medium text-destructive">missing price</span>}
          </p>
        )}
      </header>

      <div className="mt-5">
        <AddLotDialog accountId={accountId} />
      </div>

      <section className="mt-9">
        <Eyebrow className="mb-3">Lots</Eyebrow>
        {lots.length === 0 ? (
          <p className="text-sm text-muted-foreground">No lots yet. Use “Add lot” to record what you hold.</p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            {lots.map((l, i) => (
              <div key={l.lotId} className={cn("group flex items-center justify-between gap-4 px-4 py-3", i > 0 && "border-t border-border/70")}>
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    {l.instrument.symbol ? `${l.instrument.symbol} · ` : ""}
                    {l.instrument.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {fmtUnits(l.unitsScaled)} units · cost {formatMoney(l.costMinor, l.instrumentCurrency)} · {l.tradeDate}
                    {l.missingPrice && <span className="ml-1.5 rounded-full bg-destructive/10 px-1.5 py-0.5 text-[0.65rem] font-medium text-destructive">no price</span>}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <div className="shrink-0 text-right tabular-nums">
                    <p className="font-medium">{l.missingPrice ? "—" : formatMoney(l.mvMinor, l.instrumentCurrency)}</p>
                    {!l.missingPrice && (
                      <p className={cn("text-xs", l.gainMinor < 0 ? "text-destructive" : "text-muted-foreground")}>
                        {l.gainMinor >= 0 ? "+" : ""}
                        {formatMoney(l.gainMinor, l.instrumentCurrency)}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    <UpdatePrice instrumentId={l.instrument.id} accountId={accountId} label="Price" />
                    <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => delLot(l.lotId)}>
                      Delete
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
```

- [ ] **Step 2: Branch the account-detail page on valuation mode**

In `apps/web/src/routes/account-detail.tsx`:

Add the import:
```ts
import { HoldingsDetail } from "@/components/holdings-detail";
```

After the loading/not-found early return (the `if (accountsLoading || !account) { return ... }` block), add a holdings branch that renders the holdings body inside the same `AppShell`. Find the main `return (` of the component (the one rendering `<AppShell actions={<BackButton />}>` with the ledger header) and insert, just before it:

```tsx
  if (account.valuationMode === "holdings") {
    return (
      <AppShell actions={<BackButton />}>
        <HoldingsDetail accountId={id} accountName={account.name} />
      </AppShell>
    );
  }
```

(The existing ledger `return (...)` below stays unchanged for ledger accounts.)

- [ ] **Step 3: Verify the build compiles**

Run: `cd /Users/aziz/Workspace/uang/apps/web && bun run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd /Users/aziz/Workspace/uang && git add apps/web/src/components/holdings-detail.tsx apps/web/src/routes/account-detail.tsx && git commit -m "feat(web): holdings account detail (lots table, per-lot gain, actions)"
```

---

## Task 14: Full verification + manual E2E + finish

**Files:** none (verification only)

- [ ] **Step 1: Run the entire API test suite**

Run: `cd /Users/aziz/Workspace/uang/apps/api && bun test`
Expected: PASS — all suites green (holdings, valuation, accounts, instruments, lots, prices, plus the pre-existing auth/entries/fx/onboarding/users/export/networth/owners tests).

- [ ] **Step 2: Build the web app**

Run: `cd /Users/aziz/Workspace/uang/apps/web && bun run build`
Expected: PASS.

- [ ] **Step 3: Manual E2E**

Start the API and web dev servers. Then:
1. **Create holdings account:** New account → subtype *Investments* (valuation auto-switches to *Holdings*; opening-balance fields disappear) → save. It opens to the holdings detail (empty).
2. **Add a lot with a new instrument:** Add lot → "New instrument…" → name/symbol/currency/kind → units 10, unit cost 100, fees 5, trade date → Add. The lot appears; market value shows "—" (no price yet, "no price" badge).
3. **Set a price:** Use the lot's "Price" → enter 123.45 today → save. Market value shows 1,234.50, gain +229.50; account total + unrealized update; the badge clears.
4. **Dashboard:** the holdings account appears in net worth (base currency) and is included in the Household headline.
5. **As-of integrity:** add a second price at a past date and confirm value reflects carry-forward (latest ≤ today).
6. **Edit/delete a lot:** delete the lot → totals drop to 0; net worth updates.
7. **Multi-currency (optional):** create a lot on a JPY instrument, add a JPY FX rate in Settings, confirm the account total converts to base.

- [ ] **Step 4: Final commit (if manual fixups were needed)**

```bash
cd /Users/aziz/Workspace/uang && git add -A && git commit -m "test(uang): verify holdings slice end-to-end"
```
(Skip if no fixups.)

---

## Self-Review (author checklist — already applied)

- **Spec coverage:** §3 data model (no migration) → Tasks 2/3 use existing tables; §4 engine (`instrumentPriceScaled`, `lotValuation`, `holdingsAccountValuation`, carry-forward, instrument→base FX, missing flags, netWorth integration, as-of) → Tasks 1-4; §5 API (holdings create, instruments, lots CRUD, prices upsert, `GET /accounts/:id/holdings`) → Tasks 5-8; §6 UI (valuation-mode toggle, holdings detail with lots table + per-lot gain + add/edit/delete + update price + inline instrument create) → Tasks 9-13; §8 testing → unit (Tasks 2-4) + routes (Tasks 5-8) + web build gate + manual E2E (Task 14).
- **Type consistency:** `unitsScaled`/`unitCostScaled`/`feesMinor`/`priceScaled` are scaled integers everywhere (API bodies, lib inputs, collection rows, web scaling). `holdingsAccountValuation` returns `{ baseMinor, gainBaseMinor, missing, lots }`; the `GET /accounts/:id/holdings` payload reshapes to `{ baseCurrency, totalBaseMinor, totalGainBaseMinor, missing, lots }` and the web `Holdings` type matches. `lotValuation` returns `{ mvMinor, costMinor, gainMinor }` consistently.
- **Display rule:** holdings `netWorth` entries report `currency = base`, `balanceMinor = baseMinor` (Task 4) — matches the spec and the existing dashboard renderer.
- **Circular import:** avoided by extracting `latestFxRateScaled` to `fx.ts` (Task 1); `holdings.ts` and `valuation.ts` both import from it; `valuation.ts` imports `holdingsAccountValuation` (function-level use).
- **No migration:** confirmed — `instruments`/`lots`/`prices` + `valuation_mode` already in `schema.ts`; only `resetDb` is extended to clear them (Task 2).
```
