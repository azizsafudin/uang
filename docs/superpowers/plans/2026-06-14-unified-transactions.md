# Unified Transactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the split ledger/holdings model (`entries` + `lots`) with a single unified `transactions` table where every account holds a portfolio of instruments, and cash is just a `currency` instrument priced at 1.0.

**Architecture:** A new `transactions` table records signed unit changes against instruments. Current positions are computed by summing `units_delta` per instrument. Account value = Σ (position market value, converted from each instrument's currency to the target currency via `fxRates`). The `valuationMode` branch disappears — ledger and holdings accounts are now identical. The UI collapses `LedgerDetail` + `HoldingsDetail` into one `AccountHistory` component.

**Tech Stack:** Bun, Elysia, Drizzle (libsql/SQLite), Eden treaty, React, TanStack Router/Query/DB, Playwright. Spec: `docs/superpowers/specs/2026-06-14-unified-transactions-design.md`.

**No backward compatibility:** WIP project, no users. Old data is discarded. The local dev DB at `apps/api/data/uang.db` can be deleted; tests run against `:memory:`.

---

## File Structure

**Shared (`packages/shared/src/`)**
- `money.ts` — add `convertFromBase()` (inverse of `convertToBase`).
- `currencies.ts` — add `currencyName()` lookup.

**API (`apps/api/src/`)**
- `db/schema.ts` — drop `entries` + `lots`; add `transactions`; extend `instruments.kind`; drop `accounts.valuationMode`.
- `lib/positions.ts` — **new.** `instrumentPriceScaled()`, `accountPositions()`. Replaces `lib/holdings.ts` (deleted).
- `lib/valuation.ts` — rewrite: `convertMinor()`, `accountValueMinor()`, `netWorth()`. Drop `accountBalanceMinor`.
- `lib/instruments.ts` — **new.** `ensureCurrencyInstrument()`.
- `routes/transactions.ts` — **new.** Replaces `routes/entries.ts` + `routes/lots.ts` (deleted).
- `routes/positions.ts` — **new.** Replaces the `GET /accounts/:id/holdings` route.
- `routes/instruments.ts` — add `POST /instruments/currency`; widen kind enum.
- `routes/accounts.ts` — drop valuationMode + opening balance; seed currency instrument; positions-based balance.
- `app.ts` + `lib/test-helpers.ts` — wire new routes; update `resetDb`.

**Web (`apps/web/src/`)**
- `lib/collections.ts` — drop `entriesCollection`/`lotsCollection`; add `transactionsCollection`; clean `AccountRow`.
- `components/add-transaction-dialog.tsx` — **new.** Adaptive form (currency vs non-currency).
- `components/account-history.tsx` — **new.** Positions + history sections.
- `routes/account-detail.tsx` — drop valuationMode branch; render `AccountHistory`.
- `components/account-form.tsx` — drop valuation select + opening fields.
- `components/labels.ts` — drop `kindLabel`/`KIND_LABELS`; add instrument-kind labels.
- `components/update-price.tsx` — invalidate `["positions", accountId]`.
- **Delete:** `components/holdings-detail.tsx`, `components/set-balance-dialog.tsx`, `components/add-lot-dialog.tsx`.

**E2E (`e2e/tests/`)**
- `helpers.ts` — `createAccount()` (no valuation/opening).
- `accounts.spec.ts` — rewrite around transactions.
- `transactions.spec.ts` — **new** (from `holdings.spec.ts`, deleted).

**Conventions (do not break):**
- **No `as any`** anywhere except the existing Elysia `({ body, set }: any)` handler pattern.
- `SCALE = 100_000_000n` (1e8). Currency instruments: 1 unit = 1 major currency unit; price always `SCALE`.
- All money math goes through `toBig`/`fromBig`/`roundDiv` from `@uang/shared`.

---

## Phase 1 — Shared & schema foundation

### Task 1: `convertFromBase` in shared money

**Files:**
- Modify: `packages/shared/src/money.ts`
- Test: `packages/shared/src/money.test.ts` (append; create if absent)

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/money.test.ts` (if the file does not exist, create it with the imports shown):

```ts
import { expect, test } from "bun:test";
import { SCALE, convertToBase, convertFromBase } from "./money";

test("convertFromBase is the inverse of convertToBase for same-decimal currencies", () => {
  // 1 SGD = 0.74 USD → rate_scaled = 0.74 * SCALE. base=USD, to=SGD.
  const rate = (74n * SCALE) / 100n;
  // 100.00 SGD -> USD
  const usd = convertToBase(10000n, "SGD", "USD", rate); // 7400 (USD minor)
  expect(usd).toBe(7400n);
  // 7400 USD -> SGD should round-trip back to ~10000
  expect(convertFromBase(7400n, "USD", "SGD", rate)).toBe(10000n);
});

test("convertFromBase returns the amount unchanged when base === to", () => {
  expect(convertFromBase(12345n, "USD", "USD", SCALE)).toBe(12345n);
});

test("convertFromBase handles differing decimals (USD base -> JPY)", () => {
  // 1 JPY = 0.0067 USD → rate_scaled = 0.0067 * SCALE = 670000.
  const rate = 670000n;
  // 67 USD (6700 minor, 2dp) -> JPY (0 dp): 6700 / 100 / 0.0067 = 10000 JPY
  expect(convertFromBase(6700n, "USD", "JPY", rate)).toBe(10000n);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && bun test src/money.test.ts`
Expected: FAIL — `convertFromBase is not exported` / `not a function`.

- [ ] **Step 3: Implement**

Add to `packages/shared/src/money.ts` (after `convertToBase`):

```ts
// Inverse of convertToBase: convert an amount in `base` currency minor units to
// `to` currency minor units. rateScaled = (base major per 1 to-major) * SCALE — i.e.
// the SAME rate `to` would use with convertToBase. For base === to, returns unchanged.
// to_minor = round( amountBaseMinor * 10^toDec * SCALE / (10^baseDec * rateScaled) )
export function convertFromBase(
  amountBaseMinor: bigint,
  base: string,
  to: string,
  rateScaled: bigint,
): bigint {
  if (base.toUpperCase() === to.toUpperCase()) return amountBaseMinor;
  const toDec = BigInt(currencyDecimals(to));
  const baseDec = BigInt(currencyDecimals(base));
  const num = amountBaseMinor * 10n ** toDec * SCALE;
  const den = 10n ** baseDec * rateScaled;
  return roundDiv(num, den);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/shared && bun test src/money.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/money.ts packages/shared/src/money.test.ts
git commit -m "feat(shared): add convertFromBase (inverse of convertToBase)"
```

---

### Task 2: `currencyName` in shared currencies

**Files:**
- Modify: `packages/shared/src/currencies.ts`
- Test: `packages/shared/src/currencies.test.ts` (append; create if absent)

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/currencies.test.ts` (create with imports if absent):

```ts
import { expect, test } from "bun:test";
import { currencyName } from "./currencies";

test("currencyName returns a friendly name for known codes", () => {
  expect(currencyName("SGD")).toBe("Singapore Dollar");
  expect(currencyName("usd")).toBe("US Dollar");
});

test("currencyName falls back to the upper-cased code for unknown currencies", () => {
  expect(currencyName("xyz")).toBe("XYZ");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && bun test src/currencies.test.ts`
Expected: FAIL — `currencyName is not exported`.

- [ ] **Step 3: Implement**

Add to `packages/shared/src/currencies.ts` (below `currencyDecimals`):

```ts
// Friendly display names for currency instruments. Unknown codes fall back to the code.
const CURRENCY_NAMES: Record<string, string> = {
  USD: "US Dollar", EUR: "Euro", GBP: "Pound Sterling", SGD: "Singapore Dollar",
  MYR: "Malaysian Ringgit", AUD: "Australian Dollar", CAD: "Canadian Dollar",
  CHF: "Swiss Franc", JPY: "Japanese Yen", HKD: "Hong Kong Dollar", CNY: "Chinese Yuan",
  INR: "Indian Rupee", IDR: "Indonesian Rupiah", THB: "Thai Baht", PHP: "Philippine Peso",
  KRW: "South Korean Won", VND: "Vietnamese Dong",
};

export function currencyName(code: string): string {
  return CURRENCY_NAMES[code.toUpperCase()] ?? code.toUpperCase();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/shared && bun test src/currencies.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/currencies.ts packages/shared/src/currencies.test.ts
git commit -m "feat(shared): add currencyName lookup for currency instruments"
```

---

### Task 3: Schema change + migration + resetDb

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Modify: `apps/api/src/lib/test-helpers.ts:6,12-24`
- Generate: `apps/api/drizzle/0003_*.sql`

- [ ] **Step 1: Edit the schema**

In `apps/api/src/db/schema.ts`:

1. **Widen the instruments kind** (line 47). Replace:

```ts
  kind: text("kind").$type<"stock" | "etf" | "fund" | "other">().notNull(),
```

with:

```ts
  kind: text("kind").$type<"currency" | "stock" | "etf" | "fund" | "crypto" | "other">().notNull(),
```

2. **Remove `valuationMode` from `accounts`** — delete line 16:

```ts
  valuationMode: text("valuation_mode").$type<"ledger" | "holdings">().notNull(),
```

3. **Delete the `entries` table** (lines 31-40) and the **`lots` table** (lines 52-63) entirely.

4. **Add the `transactions` table** (place it where `lots` was, after `instruments`):

```ts
export const transactions = sqliteTable("transactions", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  instrumentId: text("instrument_id").notNull(),
  date: text("date").notNull(), // YYYY-MM-DD, backdating allowed
  unitsDelta: integer("units_delta").notNull(), // signed, ×1e8 (positive = acquire, negative = dispose)
  unitPriceScaled: integer("unit_price_scaled"), // price per unit at trade time ×1e8 (SCALE for currencies)
  feesMinor: integer("fees_minor").notNull().default(0),
  notes: text("notes"),
  createdAt: integer("created_at").notNull(),
  createdBy: text("created_by").notNull(),
});
```

- [ ] **Step 2: Generate the migration**

Run: `cd apps/api && bun run db:generate`
Expected: a new `drizzle/0003_*.sql` appears that drops `entries`/`lots`, creates `transactions`, and rebuilds `accounts` without `valuation_mode`. Open it and confirm it contains `CREATE TABLE \`transactions\`` and drops `entries`/`lots`. (The instruments `kind` change is TypeScript-only — `text` column, no DDL.)

- [ ] **Step 3: Update `resetDb`**

In `apps/api/src/lib/test-helpers.ts`, line 6, change the import — remove `entries`, `lots`; add `transactions`:

```ts
import { settings, user, accounts, accountOwners, memberProfiles, transactions, fxRates, instruments, prices } from "../db/schema";
```

In `resetDb` (lines 12-24), replace the `lots`/`entries` deletes with a single `transactions` delete (order matters — children before parents):

```ts
export async function resetDb() {
  await runMigrations();
  await db.delete(accountOwners);
  await db.delete(memberProfiles);
  await db.delete(transactions);
  await db.delete(prices);
  await db.delete(instruments);
  await db.delete(accounts);
  await db.delete(fxRates);
  await db.delete(settings);
  await db.delete(user);
}
```

- [ ] **Step 4: Verify migrations apply against :memory:**

Run: `cd apps/api && bun test src/routes/onboarding.test.ts`
Expected: PASS (proves `runMigrations()` applies the new migration cleanly). It is fine that other tests are now broken — later tasks fix them.

- [ ] **Step 5: Delete the stale dev DB**

Run: `rm -f apps/api/data/uang.db apps/api/data/uang.db-*`
(No output expected; the DB rebuilds from migrations on next server start.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle apps/api/src/lib/test-helpers.ts
git commit -m "feat(api): unified transactions schema; drop entries/lots/valuationMode"
```

---

## Phase 2 — Valuation libraries

### Task 4: `positions.ts` — compute positions per account

**Files:**
- Create: `apps/api/src/lib/positions.ts`
- Test: `apps/api/src/lib/positions.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/lib/positions.test.ts`:

```ts
import { expect, test, beforeEach } from "bun:test";
import { db } from "../db/client";
import { accounts, instruments, prices, transactions } from "../db/schema";
import { SCALE } from "@uang/shared";
import { createId, nowEpoch } from "./ids";
import { resetDb } from "./test-helpers";
import { accountPositions, instrumentPriceScaled } from "./positions";

beforeEach(resetDb);

const S = Number(SCALE);

async function seedAccount(currency = "USD"): Promise<string> {
  const id = createId();
  await db.insert(accounts).values({
    id, name: "Acct", class: "asset", subtype: "investment", currency,
    isArchived: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy: "u",
    growthRateBps: 0, accessibleFromAge: 0, earlyWithdrawal: "none",
    earlyHaircutBps: 0, illiquid: 0, liquidationAge: null,
  });
  return id;
}

async function addInstrument(opts: { kind?: string; currency?: string; symbol?: string }): Promise<string> {
  const id = createId();
  await db.insert(instruments).values({
    id, symbol: opts.symbol ?? "AAPL", isin: null, name: "Test Instr",
    kind: (opts.kind ?? "stock") as "currency" | "stock" | "etf" | "fund" | "crypto" | "other",
    currency: opts.currency ?? "USD", createdAt: nowEpoch(),
  });
  return id;
}

async function addTx(accountId: string, instrumentId: string, unitsMajor: number, priceMajor: number | null, date = "2026-01-01") {
  await db.insert(transactions).values({
    id: createId(), accountId, instrumentId, date,
    unitsDelta: Math.round(unitsMajor * S),
    unitPriceScaled: priceMajor === null ? null : Math.round(priceMajor * S),
    feesMinor: 0, notes: null, createdAt: nowEpoch(), createdBy: "u",
  });
}

async function addPrice(instrumentId: string, date: string, priceMajor: number) {
  await db.insert(prices).values({
    id: createId(), instrumentId, date, priceScaled: Math.round(priceMajor * S),
    source: "manual", createdAt: nowEpoch(),
  });
}

test("currency position: units sum, price 1.0, no gain", async () => {
  const acc = await seedAccount("SGD");
  const sgd = await addInstrument({ kind: "currency", currency: "SGD", symbol: "SGD" });
  await addTx(acc, sgd, 500, 1, "2026-01-01");
  await addTx(acc, sgd, -120, 1, "2026-02-01");

  const pos = await accountPositions(acc);
  expect(pos.length).toBe(1);
  expect(pos[0].units).toBe(380 * S);
  expect(pos[0].currentPriceScaled).toBe(S);
  expect(pos[0].avgCostScaled).toBe(S);
  expect(pos[0].marketValueMinor).toBe(38000); // 380.00 SGD
  expect(pos[0].unrealizedGainMinor).toBe(0);
  expect(pos[0].missingPrice).toBe(false);
});

test("stock position: weighted avg cost, market value, unrealized gain", async () => {
  const acc = await seedAccount("USD");
  const aapl = await addInstrument({ kind: "stock", currency: "USD" });
  await addTx(acc, aapl, 10, 100, "2026-01-01"); // 10 @ 100
  await addTx(acc, aapl, 10, 120, "2026-02-01"); // 10 @ 120 → avg 110
  await addPrice(aapl, "2026-03-01", 130);

  const pos = await accountPositions(acc);
  expect(pos.length).toBe(1);
  expect(pos[0].units).toBe(20 * S);
  expect(pos[0].avgCostScaled).toBe(110 * S);
  expect(pos[0].currentPriceScaled).toBe(130 * S);
  expect(pos[0].marketValueMinor).toBe(260000); // 20 × 130 = 2600.00
  expect(pos[0].unrealizedGainMinor).toBe(40000); // (130-110) × 20 = 400.00
});

test("stock with no price is flagged missingPrice and zero-valued", async () => {
  const acc = await seedAccount("USD");
  const aapl = await addInstrument({ kind: "stock", currency: "USD" });
  await addTx(acc, aapl, 5, 100, "2026-01-01");

  const pos = await accountPositions(acc);
  expect(pos[0].missingPrice).toBe(true);
  expect(pos[0].marketValueMinor).toBe(0);
});

test("fully-disposed instrument (net units 0) is omitted", async () => {
  const acc = await seedAccount("USD");
  const aapl = await addInstrument({ kind: "stock", currency: "USD" });
  await addTx(acc, aapl, 5, 100, "2026-01-01");
  await addTx(acc, aapl, -5, 110, "2026-02-01");

  const pos = await accountPositions(acc);
  expect(pos.length).toBe(0);
});

test("asOf excludes later transactions and uses carry-forward price", async () => {
  const acc = await seedAccount("USD");
  const aapl = await addInstrument({ kind: "stock", currency: "USD" });
  await addTx(acc, aapl, 10, 100, "2026-01-01");
  await addTx(acc, aapl, 10, 100, "2026-03-01");
  await addPrice(aapl, "2026-01-15", 105);

  const pos = await accountPositions(acc, "2026-02-01");
  expect(pos[0].units).toBe(10 * S);
  expect(pos[0].currentPriceScaled).toBe(105 * S);
});

test("instrumentPriceScaled carries forward the latest price <= asOf", async () => {
  const aapl = await addInstrument({ kind: "stock", currency: "USD" });
  await addPrice(aapl, "2026-01-01", 100);
  await addPrice(aapl, "2026-03-01", 120);
  expect(await instrumentPriceScaled(aapl, "2026-02-15")).toBe(100 * S);
  expect(await instrumentPriceScaled(aapl, "2025-12-31")).toBe(null);
  expect(await instrumentPriceScaled(aapl)).toBe(120 * S);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun test src/lib/positions.test.ts`
Expected: FAIL — cannot resolve `./positions`.

- [ ] **Step 3: Implement**

Create `apps/api/src/lib/positions.ts`:

```ts
import { db } from "../db/client";
import { prices, transactions, instruments } from "../db/schema";
import { and, eq, lte, desc } from "drizzle-orm";
import { SCALE, roundDiv, toBig, fromBig, currencyDecimals } from "@uang/shared";

// Latest manual price for an instrument with date <= asOf (carry-forward), or latest
// overall if asOf absent. null if none. Returns price_scaled (price-per-unit × 1e8).
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

export type Position = {
  instrument: { id: string; symbol: string | null; name: string; kind: string; currency: string };
  instrumentCurrency: string;
  units: number;               // net units held, ×1e8
  avgCostScaled: number;       // weighted average acquisition price, ×1e8
  currentPriceScaled: number | null;
  marketValueMinor: number;    // in the instrument's currency minor units
  unrealizedGainMinor: number; // in the instrument's currency minor units (0 for currency kind)
  missingPrice: boolean;       // true if no price (non-currency) -> excluded from totals
};

// mv = round( units_scaled * price_scaled * 10^dec / (SCALE * SCALE) ), instrument-currency minor.
function valueMinor(unitsScaled: bigint, priceScaled: bigint, dec: number): bigint {
  return roundDiv(unitsScaled * priceScaled * 10n ** BigInt(dec), SCALE * SCALE);
}

// Net positions for an account (transactions with date <= asOf). Currency instruments are
// priced at 1.0 (SCALE) and never carry an unrealized gain.
export async function accountPositions(accountId: string, asOf?: string): Promise<Position[]> {
  const where = asOf
    ? and(eq(transactions.accountId, accountId), lte(transactions.date, asOf))
    : eq(transactions.accountId, accountId);
  const rows = await db
    .select()
    .from(transactions)
    .innerJoin(instruments, eq(transactions.instrumentId, instruments.id))
    .where(where);

  type Agg = {
    instrument: (typeof rows)[number]["instruments"];
    units: bigint;     // Σ units_delta
    acqUnits: bigint;  // Σ units_delta where > 0
    acqCost: bigint;   // Σ units_delta × unit_price (scale²) where > 0
  };
  const byInstr = new Map<string, Agg>();
  for (const row of rows) {
    const tx = row.transactions;
    const instr = row.instruments;
    let agg = byInstr.get(instr.id);
    if (!agg) { agg = { instrument: instr, units: 0n, acqUnits: 0n, acqCost: 0n }; byInstr.set(instr.id, agg); }
    const d = toBig(tx.unitsDelta);
    agg.units += d;
    if (d > 0n) {
      const isCurrency = instr.kind === "currency";
      const price = tx.unitPriceScaled ?? (isCurrency ? Number(SCALE) : 0);
      agg.acqUnits += d;
      agg.acqCost += d * toBig(price);
    }
  }

  const out: Position[] = [];
  for (const agg of byInstr.values()) {
    if (agg.units === 0n) continue;
    const instr = agg.instrument;
    const isCurrency = instr.kind === "currency";
    const dec = currencyDecimals(instr.currency);

    const avgCostScaled = isCurrency
      ? Number(SCALE)
      : agg.acqUnits > 0n ? fromBig(roundDiv(agg.acqCost, agg.acqUnits)) : 0;

    const currentPriceScaled = isCurrency
      ? Number(SCALE)
      : await instrumentPriceScaled(instr.id, asOf);

    let marketValueMinor = 0;
    let unrealizedGainMinor = 0;
    let missingPrice = false;

    if (currentPriceScaled === null) {
      missingPrice = true;
    } else {
      marketValueMinor = fromBig(valueMinor(agg.units, toBig(currentPriceScaled), dec));
      if (!isCurrency) {
        const diff = toBig(currentPriceScaled) - toBig(avgCostScaled);
        unrealizedGainMinor = fromBig(roundDiv(agg.units * diff * 10n ** BigInt(dec), SCALE * SCALE));
      }
    }

    out.push({
      instrument: { id: instr.id, symbol: instr.symbol, name: instr.name, kind: instr.kind, currency: instr.currency },
      instrumentCurrency: instr.currency,
      units: fromBig(agg.units),
      avgCostScaled,
      currentPriceScaled,
      marketValueMinor,
      unrealizedGainMinor,
      missingPrice,
    });
  }

  out.sort((a, b) => a.instrument.name.localeCompare(b.instrument.name));
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && bun test src/lib/positions.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/positions.ts apps/api/src/lib/positions.test.ts
git commit -m "feat(api): accountPositions — positions from unified transactions"
```

---

### Task 5: Rewrite `valuation.ts`; delete `holdings.ts`

**Files:**
- Modify: `apps/api/src/lib/valuation.ts` (full rewrite)
- Delete: `apps/api/src/lib/holdings.ts`, `apps/api/src/lib/holdings.test.ts`
- Test: `apps/api/src/lib/valuation.test.ts` (full rewrite)

- [ ] **Step 1: Delete the obsolete holdings module and its test**

```bash
git rm apps/api/src/lib/holdings.ts apps/api/src/lib/holdings.test.ts
```

- [ ] **Step 2: Write the new valuation test (replace the file's contents)**

Replace `apps/api/src/lib/valuation.test.ts` entirely with:

```ts
import { expect, test, beforeEach } from "bun:test";
import { db } from "../db/client";
import { accounts, accountOwners, instruments, prices, transactions, fxRates, settings } from "../db/schema";
import { SCALE } from "@uang/shared";
import { createId, nowEpoch } from "./ids";
import { resetDb } from "./test-helpers";
import { netWorth, accountValueMinor, convertMinor } from "./valuation";

beforeEach(resetDb);

const S = Number(SCALE);

async function setBase(base: string) {
  await db.insert(settings).values({ id: 1, householdName: "H", baseCurrency: base, createdAt: nowEpoch() });
}

async function seedAccount(opts: { currency: string; cls?: "asset" | "liability"; owner?: string }): Promise<string> {
  const id = createId();
  await db.insert(accounts).values({
    id, name: "Acct", class: opts.cls ?? "asset", subtype: "bank", currency: opts.currency,
    isArchived: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy: "u",
    growthRateBps: 0, accessibleFromAge: 0, earlyWithdrawal: "none",
    earlyHaircutBps: 0, illiquid: 0, liquidationAge: null,
  });
  if (opts.owner) await db.insert(accountOwners).values({ accountId: id, userId: opts.owner });
  return id;
}

async function addCurrencyInstrument(currency: string): Promise<string> {
  const id = createId();
  await db.insert(instruments).values({
    id, symbol: currency, isin: null, name: currency, kind: "currency", currency, createdAt: nowEpoch(),
  });
  return id;
}

async function cashTx(accountId: string, instrumentId: string, amountMajor: number, date = "2026-01-01") {
  await db.insert(transactions).values({
    id: createId(), accountId, instrumentId, date,
    unitsDelta: Math.round(amountMajor * S), unitPriceScaled: S,
    feesMinor: 0, notes: null, createdAt: nowEpoch(), createdBy: "u",
  });
}

async function addFx(currency: string, date: string, rateMajor: number) {
  await db.insert(fxRates).values({
    id: createId(), currency, date, rateScaled: Math.round(rateMajor * S), createdAt: nowEpoch(),
  });
}

test("convertMinor routes X->base->Y and returns null on a missing rate", async () => {
  await setBase("USD");
  await addFx("SGD", "2026-01-01", 0.74);
  // SGD -> USD
  expect(await convertMinor(10000, "SGD", "USD", "USD")).toBe(7400);
  // USD -> USD identity
  expect(await convertMinor(5000, "USD", "USD", "USD")).toBe(5000);
  // EUR has no rate -> null
  expect(await convertMinor(5000, "EUR", "USD", "USD")).toBe(null);
});

test("accountValueMinor sums cash positions in the target currency", async () => {
  await setBase("USD");
  const acc = await seedAccount({ currency: "USD" });
  const usd = await addCurrencyInstrument("USD");
  await cashTx(acc, usd, 1000);
  await cashTx(acc, usd, -250, "2026-02-01");
  const { valueMinor, missing } = await accountValueMinor(acc, "USD", "USD");
  expect(valueMinor).toBe(75000); // 750.00
  expect(missing).toBe(false);
});

test("netWorth converts a foreign-currency account to base", async () => {
  await setBase("USD");
  await addFx("SGD", "2026-01-01", 0.74);
  const acc = await seedAccount({ currency: "SGD" });
  const sgd = await addCurrencyInstrument("SGD");
  await cashTx(acc, sgd, 1000); // 1000 SGD

  const nw = await netWorth();
  expect(nw.baseCurrency).toBe("USD");
  expect(nw.accounts.length).toBe(1);
  expect(nw.accounts[0].currency).toBe("SGD");
  expect(nw.accounts[0].balanceMinor).toBe(100000); // 1000.00 SGD (account currency)
  expect(nw.accounts[0].baseMinor).toBe(74000);      // 740.00 USD
  expect(nw.totalBaseMinor).toBe(74000);
});

test("netWorth flags missingRate and excludes the account from the total", async () => {
  await setBase("USD");
  const acc = await seedAccount({ currency: "EUR" }); // no FX rate seeded
  const eur = await addCurrencyInstrument("EUR");
  await cashTx(acc, eur, 500);

  const nw = await netWorth();
  expect(nw.accounts[0].missingRate).toBe(true);
  expect(nw.totalBaseMinor).toBe(0);
});

test("netWorth owner filter shows only solely-owned accounts", async () => {
  await setBase("USD");
  const mine = await seedAccount({ currency: "USD", owner: "me" });
  const usd = await addCurrencyInstrument("USD");
  await cashTx(mine, usd, 100);
  const shared = await seedAccount({ currency: "USD" });
  await db.insert(accountOwners).values({ accountId: shared, userId: "me" });
  await db.insert(accountOwners).values({ accountId: shared, userId: "you" });
  await cashTx(shared, usd, 999);

  const nw = await netWorth({ owner: "me" });
  expect(nw.accounts.length).toBe(1);
  expect(nw.totalBaseMinor).toBe(10000);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/api && bun test src/lib/valuation.test.ts`
Expected: FAIL — `accountValueMinor`/`convertMinor` not exported; `accountBalanceMinor` removed.

- [ ] **Step 4: Implement the rewrite**

Replace `apps/api/src/lib/valuation.ts` entirely with:

```ts
import { db } from "../db/client";
import { accounts, settings } from "../db/schema";
import { eq } from "drizzle-orm";
import { convertToBase, convertFromBase, toBig, fromBig, SCALE } from "@uang/shared";
import { latestFxRateScaled } from "./fx";
import { accountPositions } from "./positions";
import { getAllOwnerSets } from "./owners";

// Convert an amount in `from` currency minor units to `to` currency minor units, routing
// through `base` (X→base via fx(X); base→Y via fx(Y) inverse). null if a needed rate is
// missing. Identity when from === to.
export async function convertMinor(
  amountMinor: number, from: string, to: string, base: string, asOf?: string,
): Promise<number | null> {
  if (from.toUpperCase() === to.toUpperCase()) return amountMinor;

  let baseMinor: number;
  if (from.toUpperCase() === base.toUpperCase()) {
    baseMinor = amountMinor;
  } else {
    const r = await latestFxRateScaled(from, asOf);
    if (r === null) return null;
    baseMinor = fromBig(convertToBase(toBig(amountMinor), from, base, toBig(r)));
  }

  if (to.toUpperCase() === base.toUpperCase()) return baseMinor;
  const r2 = await latestFxRateScaled(to, asOf);
  if (r2 === null) return null;
  return fromBig(convertFromBase(toBig(baseMinor), base, to, toBig(r2)));
}

// Total value of an account in `target` currency by summing each position's market value
// (in the instrument's currency) converted to `target`. A missing price or missing FX rate
// flags `missing` and excludes that position.
export async function accountValueMinor(
  accountId: string, target: string, base: string, asOf?: string,
): Promise<{ valueMinor: number; missing: boolean }> {
  const positions = await accountPositions(accountId, asOf);
  let total = 0n;
  let missing = false;
  for (const p of positions) {
    if (p.missingPrice) { missing = true; continue; }
    const conv = await convertMinor(p.marketValueMinor, p.instrumentCurrency, target, base, asOf);
    if (conv === null) { missing = true; continue; }
    total += toBig(conv);
  }
  return { valueMinor: fromBig(total), missing };
}

export type AccountValuation = {
  id: string; name: string; class: string; subtype: string; currency: string;
  balanceMinor: number; baseMinor: number; missingRate: boolean;
  ownerIds: string[]; shared: boolean;
  growthRateBps: number;
  accessibleFromAge: number;
  earlyWithdrawal: "none" | "penalty";
  earlyHaircutBps: number;
  illiquid: boolean;
  liquidationAge: number | null;
};

export type NetWorthOpts = { asOf?: string; owner?: string };

export type NetWorth = {
  baseCurrency: string;
  totalBaseMinor: number;
  accounts: AccountValuation[];
};

export async function netWorth(opts: NetWorthOpts = {}): Promise<NetWorth> {
  const { asOf, owner } = opts;
  const s = (await db.select().from(settings).where(eq(settings.id, 1)))[0];
  const base = s?.baseCurrency ?? "USD";
  const accts = await db.select().from(accounts).where(eq(accounts.isArchived, 0));
  const ownerSets = await getAllOwnerSets();

  let total = 0n;
  const out: AccountValuation[] = [];
  for (const a of accts) {
    const ownerIds = ownerSets.get(a.id) ?? [];
    const shared = ownerIds.length >= 2;

    // Owner filter: a specific member sees only accounts they solely own.
    if (owner && owner !== "household") {
      const personalToOwner = ownerIds.length === 1 && ownerIds[0] === owner;
      if (!personalToOwner) continue;
    }

    const baseRes = await accountValueMinor(a.id, base, base, asOf);
    const dispRes = await accountValueMinor(a.id, a.currency, base, asOf);
    const missingRate = baseRes.missing;
    if (!missingRate) total += toBig(baseRes.valueMinor);

    out.push({
      id: a.id, name: a.name, class: a.class, subtype: a.subtype, currency: a.currency,
      balanceMinor: dispRes.valueMinor, baseMinor: baseRes.valueMinor, missingRate, ownerIds, shared,
      growthRateBps: a.growthRateBps,
      accessibleFromAge: a.accessibleFromAge,
      earlyWithdrawal: a.earlyWithdrawal,
      earlyHaircutBps: a.earlyHaircutBps,
      illiquid: a.illiquid === 1,
      liquidationAge: a.liquidationAge ?? null,
    });
  }
  return { baseCurrency: base, totalBaseMinor: fromBig(total), accounts: out };
}

export { SCALE };
export { latestFxRateScaled };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/api && bun test src/lib/valuation.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/valuation.ts apps/api/src/lib/valuation.test.ts apps/api/src/lib/holdings.ts apps/api/src/lib/holdings.test.ts
git commit -m "feat(api): positions-based valuation; remove holdings module"
```

---

## Phase 3 — API routes

### Task 6: `ensureCurrencyInstrument` helper

**Files:**
- Create: `apps/api/src/lib/instruments.ts`
- Test: `apps/api/src/lib/instruments.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/lib/instruments.test.ts`:

```ts
import { expect, test, beforeEach } from "bun:test";
import { db } from "../db/client";
import { instruments } from "../db/schema";
import { eq } from "drizzle-orm";
import { resetDb } from "./test-helpers";
import { ensureCurrencyInstrument } from "./instruments";

beforeEach(resetDb);

test("creates a currency instrument once and is idempotent", async () => {
  const id1 = await ensureCurrencyInstrument("sgd");
  const id2 = await ensureCurrencyInstrument("SGD");
  expect(id1).toBe(id2);

  const rows = await db.select().from(instruments).where(eq(instruments.symbol, "SGD"));
  expect(rows.length).toBe(1);
  expect(rows[0].kind).toBe("currency");
  expect(rows[0].currency).toBe("SGD");
  expect(rows[0].name).toBe("Singapore Dollar");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun test src/lib/instruments.test.ts`
Expected: FAIL — cannot resolve `./instruments`.

- [ ] **Step 3: Implement**

Create `apps/api/src/lib/instruments.ts`:

```ts
import { db } from "../db/client";
import { instruments } from "../db/schema";
import { and, eq } from "drizzle-orm";
import { currencyName } from "@uang/shared";
import { createId, nowEpoch } from "./ids";

// Find-or-create the currency instrument for `symbol`. Idempotent; returns its id.
export async function ensureCurrencyInstrument(symbol: string): Promise<string> {
  const sym = symbol.toUpperCase();
  const existing = await db
    .select({ id: instruments.id })
    .from(instruments)
    .where(and(eq(instruments.kind, "currency"), eq(instruments.symbol, sym)));
  if (existing[0]) return existing[0].id;

  const id = createId();
  await db.insert(instruments).values({
    id, symbol: sym, isin: null, name: currencyName(sym),
    kind: "currency", currency: sym, createdAt: nowEpoch(),
  });
  return id;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && bun test src/lib/instruments.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/instruments.ts apps/api/src/lib/instruments.test.ts
git commit -m "feat(api): ensureCurrencyInstrument helper"
```

---

### Task 7: Instruments route — currency endpoint + widened kind

**Files:**
- Modify: `apps/api/src/routes/instruments.ts`
- Test: `apps/api/src/routes/instruments.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/routes/instruments.test.ts` (match the existing file's `makeApp`/`initAndLogin` setup — read its top for the exact `app` variable name; the snippet below assumes `const app = makeApp(instrumentsRoutes)`):

```ts
test("POST /instruments/currency find-or-creates and is idempotent", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });

  const r1 = await app.handle(new Request("http://localhost/instruments/currency", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ symbol: "sgd" }),
  }));
  expect(r1.status).toBe(200);
  const b1 = await r1.json();
  expect(b1.symbol).toBe("SGD");
  expect(b1.kind).toBe("currency");

  const r2 = await app.handle(new Request("http://localhost/instruments/currency", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ symbol: "SGD" }),
  }));
  const b2 = await r2.json();
  expect(b2.id).toBe(b1.id);
});

test("POST /instruments accepts crypto kind", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const res = await app.handle(new Request("http://localhost/instruments", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Bitcoin", kind: "crypto", currency: "USD", symbol: "BTC" }),
  }));
  expect(res.status).toBe(200);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun test src/routes/instruments.test.ts`
Expected: FAIL — `/instruments/currency` 404; `crypto` rejected by validator.

- [ ] **Step 3: Implement**

Replace `apps/api/src/routes/instruments.ts` entirely with:

```ts
import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { instruments } from "../db/schema";
import { eq } from "drizzle-orm";
import { authGuard } from "../lib/auth-guard";
import { createId, nowEpoch } from "../lib/ids";
import { ensureCurrencyInstrument } from "../lib/instruments";

export const instrumentsRoutes = new Elysia({ prefix: "/instruments" })
  .use(authGuard)
  .get("/", async () => db.select().from(instruments).orderBy(instruments.name))
  // Find-or-create the currency instrument for a symbol; returns the full row.
  .post(
    "/currency",
    async ({ body }) => {
      const id = await ensureCurrencyInstrument(body.symbol);
      const [row] = await db.select().from(instruments).where(eq(instruments.id, id));
      return row;
    },
    { body: t.Object({ symbol: t.String({ pattern: "^[A-Za-z]{3}$" }) }) },
  )
  .post(
    "/",
    async ({ body }) => {
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
        kind: t.Union([
          t.Literal("stock"), t.Literal("etf"), t.Literal("fund"),
          t.Literal("crypto"), t.Literal("other"),
        ]),
        currency: t.String({ pattern: "^[A-Za-z]{3}$" }),
        symbol: t.Optional(t.String()),
        isin: t.Optional(t.String()),
      }),
    },
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && bun test src/routes/instruments.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/instruments.ts apps/api/src/routes/instruments.test.ts
git commit -m "feat(api): POST /instruments/currency + crypto kind"
```

---

### Task 8: Transactions route

**Files:**
- Create: `apps/api/src/routes/transactions.ts`
- Test: `apps/api/src/routes/transactions.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/transactions.test.ts`:

```ts
import { expect, test, beforeEach } from "bun:test";
import { db } from "../db/client";
import { accounts, instruments, transactions } from "../db/schema";
import { eq } from "drizzle-orm";
import { SCALE } from "@uang/shared";
import { createId, nowEpoch } from "../lib/ids";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { transactionsRoutes } from "./transactions";

beforeEach(resetDb);
const app = makeApp(transactionsRoutes);
const S = Number(SCALE);

async function seedAccount(currency = "USD"): Promise<string> {
  const id = createId();
  await db.insert(accounts).values({
    id, name: "Acct", class: "asset", subtype: "investment", currency,
    isArchived: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy: "u",
    growthRateBps: 0, accessibleFromAge: 0, earlyWithdrawal: "none",
    earlyHaircutBps: 0, illiquid: 0, liquidationAge: null,
  });
  return id;
}

async function seedInstrument(kind: string, currency = "USD"): Promise<string> {
  const id = createId();
  await db.insert(instruments).values({
    id, symbol: "X", isin: null, name: "Instr",
    kind: kind as "currency" | "stock" | "etf" | "fund" | "crypto" | "other",
    currency, createdAt: nowEpoch(),
  });
  return id;
}

test("POST creates a transaction and GET lists it with instrument info, date desc", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const acc = await seedAccount();
  const instr = await seedInstrument("stock");

  const create = await app.handle(new Request(`http://localhost/accounts/${acc}/transactions`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ instrumentId: instr, date: "2026-01-01", unitsDelta: 10 * S, unitPriceScaled: 100 * S }),
  }));
  expect(create.status).toBe(200);

  await app.handle(new Request(`http://localhost/accounts/${acc}/transactions`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ instrumentId: instr, date: "2026-03-01", unitsDelta: 5 * S, unitPriceScaled: 120 * S }),
  }));

  const list = await (await app.handle(new Request(`http://localhost/accounts/${acc}/transactions`, { headers: { cookie } }))).json();
  expect(list.length).toBe(2);
  expect(list[0].date).toBe("2026-03-01"); // desc
  expect(list[0].instrument.kind).toBe("stock");
});

test("POST rejects an unknown instrument with 422", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const acc = await seedAccount();
  const res = await app.handle(new Request(`http://localhost/accounts/${acc}/transactions`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ instrumentId: "nope", date: "2026-01-01", unitsDelta: 100 }),
  }));
  expect(res.status).toBe(422);
});

test("POST with cashLeg atomically writes both legs", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const acc = await seedAccount();
  const stock = await seedInstrument("stock");
  const usd = await seedInstrument("currency", "USD");

  const res = await app.handle(new Request(`http://localhost/accounts/${acc}/transactions`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      instrumentId: stock, date: "2026-01-01", unitsDelta: 10 * S, unitPriceScaled: 100 * S, feesMinor: 500,
      cashLeg: { instrumentId: usd, unitsDelta: -1005 * S },
    }),
  }));
  expect(res.status).toBe(200);
  const rows = await db.select().from(transactions).where(eq(transactions.accountId, acc));
  expect(rows.length).toBe(2);
});

test("PATCH edits fields; DELETE removes the row", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const acc = await seedAccount();
  const instr = await seedInstrument("stock");
  const txId = createId();
  await db.insert(transactions).values({
    id: txId, accountId: acc, instrumentId: instr, date: "2026-01-01",
    unitsDelta: 10 * S, unitPriceScaled: 100 * S, feesMinor: 0, notes: null,
    createdAt: nowEpoch(), createdBy: "u",
  });

  const patch = await app.handle(new Request(`http://localhost/transactions/${txId}`, {
    method: "PATCH", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ unitsDelta: 20 * S, notes: "topped up" }),
  }));
  expect(patch.status).toBe(200);
  const [after] = await db.select().from(transactions).where(eq(transactions.id, txId));
  expect(after.unitsDelta).toBe(20 * S);
  expect(after.notes).toBe("topped up");

  await app.handle(new Request(`http://localhost/transactions/${txId}`, { method: "DELETE", headers: { cookie } }));
  const remaining = await db.select().from(transactions).where(eq(transactions.id, txId));
  expect(remaining.length).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun test src/routes/transactions.test.ts`
Expected: FAIL — cannot resolve `./transactions`.

- [ ] **Step 3: Implement**

Create `apps/api/src/routes/transactions.ts`:

```ts
import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { transactions, instruments } from "../db/schema";
import { eq, desc } from "drizzle-orm";
import { SCALE } from "@uang/shared";
import { authGuard } from "../lib/auth-guard";
import { createId, nowEpoch } from "../lib/ids";
import { isUniqueViolation } from "../lib/db-errors";

const CASH_PRICE = Number(SCALE); // currency instruments are priced at 1.0

export const transactionsRoutes = new Elysia()
  .use(authGuard)
  .get("/accounts/:id/transactions", async ({ params }) => {
    const rows = await db
      .select()
      .from(transactions)
      .innerJoin(instruments, eq(transactions.instrumentId, instruments.id))
      .where(eq(transactions.accountId, params.id))
      .orderBy(desc(transactions.date));
    return rows.map((r) => ({
      ...r.transactions,
      instrument: {
        id: r.instruments.id, symbol: r.instruments.symbol, name: r.instruments.name,
        kind: r.instruments.kind, currency: r.instruments.currency,
      },
    }));
  })
  .post(
    "/accounts/:id/transactions",
    async ({ params, body, userId, set }: any) => {
      const instr = await db.select({ id: instruments.id }).from(instruments).where(eq(instruments.id, body.instrumentId));
      if (instr.length === 0) { set.status = 422; return { error: "unknown_instrument" }; }

      const now = nowEpoch();
      const mainId = body.id ?? createId();
      try {
        await db.transaction(async (tx) => {
          await tx.insert(transactions).values({
            id: mainId, accountId: params.id, instrumentId: body.instrumentId,
            date: body.date, unitsDelta: body.unitsDelta,
            unitPriceScaled: body.unitPriceScaled ?? null, feesMinor: body.feesMinor ?? 0,
            notes: body.notes ?? null, createdAt: now, createdBy: userId!,
          });
          if (body.cashLeg) {
            const cl = body.cashLeg;
            const cinstr = await tx.select({ id: instruments.id }).from(instruments).where(eq(instruments.id, cl.instrumentId));
            if (cinstr.length === 0) throw new Error("unknown_cash_instrument");
            await tx.insert(transactions).values({
              id: createId(), accountId: params.id, instrumentId: cl.instrumentId,
              date: body.date, unitsDelta: cl.unitsDelta,
              unitPriceScaled: cl.unitPriceScaled ?? CASH_PRICE, feesMinor: 0,
              notes: cl.notes ?? null, createdAt: now, createdBy: userId!,
            });
          }
        });
      } catch (e) {
        if (isUniqueViolation(e)) { set.status = 409; return { error: "duplicate_id" }; }
        if (e instanceof Error && e.message === "unknown_cash_instrument") {
          set.status = 422; return { error: "unknown_cash_instrument" };
        }
        throw e;
      }
      return { id: mainId };
    },
    {
      body: t.Object({
        id: t.Optional(t.String()),
        instrumentId: t.String(),
        date: t.String(),
        unitsDelta: t.Number(),
        unitPriceScaled: t.Optional(t.Number()),
        feesMinor: t.Optional(t.Number()),
        notes: t.Optional(t.String()),
        cashLeg: t.Optional(t.Object({
          instrumentId: t.String(),
          unitsDelta: t.Number(),
          unitPriceScaled: t.Optional(t.Number()),
          notes: t.Optional(t.String()),
        })),
      }),
    },
  )
  .patch(
    "/transactions/:id",
    async ({ params, body }: any) => {
      const update: Record<string, unknown> = {};
      if (body.date !== undefined) update.date = body.date;
      if (body.unitsDelta !== undefined) update.unitsDelta = body.unitsDelta;
      if (body.unitPriceScaled !== undefined) update.unitPriceScaled = body.unitPriceScaled;
      if (body.feesMinor !== undefined) update.feesMinor = body.feesMinor;
      if (body.notes !== undefined) update.notes = body.notes;
      await db.update(transactions).set(update).where(eq(transactions.id, params.id));
      return { ok: true };
    },
    {
      body: t.Object({
        date: t.Optional(t.String()),
        unitsDelta: t.Optional(t.Number()),
        unitPriceScaled: t.Optional(t.Number()),
        feesMinor: t.Optional(t.Number()),
        notes: t.Optional(t.String()),
      }),
    },
  )
  .delete("/transactions/:id", async ({ params }) => {
    await db.delete(transactions).where(eq(transactions.id, params.id));
    return { ok: true };
  });
```

> **Note on `db.transaction`:** the libsql Drizzle driver supports interactive transactions via `db.transaction(async (tx) => {…})`. If the test surfaces a driver error about nested/unsupported transactions, fall back to two sequential `db.insert` calls (acceptable for this WIP, single-user app) and remove the `db.transaction` wrapper.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && bun test src/routes/transactions.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/transactions.ts apps/api/src/routes/transactions.test.ts
git commit -m "feat(api): transactions routes (list/create/edit/delete + cash leg)"
```

---

### Task 9: Positions route

**Files:**
- Create: `apps/api/src/routes/positions.ts`
- Test: `apps/api/src/routes/positions.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/positions.test.ts`:

```ts
import { expect, test, beforeEach } from "bun:test";
import { db } from "../db/client";
import { accounts, instruments, prices, transactions } from "../db/schema";
import { SCALE } from "@uang/shared";
import { createId, nowEpoch } from "../lib/ids";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { positionsRoutes } from "./positions";

beforeEach(resetDb);
const app = makeApp(positionsRoutes);
const S = Number(SCALE);

async function seedAccount(currency = "USD"): Promise<string> {
  const id = createId();
  await db.insert(accounts).values({
    id, name: "Acct", class: "asset", subtype: "investment", currency,
    isArchived: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy: "u",
    growthRateBps: 0, accessibleFromAge: 0, earlyWithdrawal: "none",
    earlyHaircutBps: 0, illiquid: 0, liquidationAge: null,
  });
  return id;
}

test("GET /accounts/:id/positions returns positions and account total", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const acc = await seedAccount("USD");
  const aapl = createId();
  await db.insert(instruments).values({ id: aapl, symbol: "AAPL", isin: null, name: "Apple", kind: "stock", currency: "USD", createdAt: nowEpoch() });
  await db.insert(transactions).values({ id: createId(), accountId: acc, instrumentId: aapl, date: "2026-01-01", unitsDelta: 10 * S, unitPriceScaled: 100 * S, feesMinor: 0, notes: null, createdAt: nowEpoch(), createdBy: "u" });
  await db.insert(prices).values({ id: createId(), instrumentId: aapl, date: "2026-02-01", priceScaled: 120 * S, source: "manual", createdAt: nowEpoch() });

  const res = await app.handle(new Request(`http://localhost/accounts/${acc}/positions`, { headers: { cookie } }));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.accountCurrency).toBe("USD");
  expect(body.totalMinor).toBe(120000); // 10 × 120 = 1200.00
  expect(body.positions.length).toBe(1);
  expect(body.positions[0].valueDisplayMinor).toBe(120000);
  expect(body.positions[0].unrealizedGainMinor).toBe(20000); // (120-100)×10
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun test src/routes/positions.test.ts`
Expected: FAIL — cannot resolve `./positions`.

- [ ] **Step 3: Implement**

Create `apps/api/src/routes/positions.ts`:

```ts
import { Elysia } from "elysia";
import { db } from "../db/client";
import { accounts, settings } from "../db/schema";
import { eq } from "drizzle-orm";
import { authGuard } from "../lib/auth-guard";
import { accountPositions } from "../lib/positions";
import { accountValueMinor, convertMinor } from "../lib/valuation";

export const positionsRoutes = new Elysia()
  .use(authGuard)
  .get("/accounts/:id/positions", async ({ params }) => {
    const s = (await db.select().from(settings).where(eq(settings.id, 1)))[0];
    const base = s?.baseCurrency ?? "USD";
    const [acct] = await db.select().from(accounts).where(eq(accounts.id, params.id));
    const accountCurrency = acct?.currency ?? base;

    const positions = await accountPositions(params.id);
    const enriched = await Promise.all(positions.map(async (p) => {
      if (p.missingPrice) return { ...p, valueDisplayMinor: 0, valueMissing: true };
      const conv = await convertMinor(p.marketValueMinor, p.instrumentCurrency, accountCurrency, base);
      return { ...p, valueDisplayMinor: conv ?? 0, valueMissing: conv === null };
    }));

    const totalDisp = await accountValueMinor(params.id, accountCurrency, base);
    const totalBase = await accountValueMinor(params.id, base, base);

    return {
      accountCurrency,
      baseCurrency: base,
      totalMinor: totalDisp.valueMinor,
      totalBaseMinor: totalBase.valueMinor,
      missing: totalBase.missing,
      positions: enriched,
    };
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && bun test src/routes/positions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/positions.ts apps/api/src/routes/positions.test.ts
git commit -m "feat(api): GET /accounts/:id/positions"
```

---

### Task 10: Accounts route — drop valuationMode/opening, seed currency, positions balance

**Files:**
- Modify: `apps/api/src/routes/accounts.ts`
- Test: `apps/api/src/routes/accounts.test.ts` (update)

- [ ] **Step 1: Update the accounts test**

Open `apps/api/src/routes/accounts.test.ts`. Make these changes:

1. In any account-seeding helper or `POST /accounts` body in the test, **remove** `valuationMode`, `openingBalanceMinor`, and `openingDate`.
2. Replace any assertion that a created account has an opening **entry** with this assertion that account creation seeds a **currency instrument**. Add this test (adjust `app`/imports to match the file; it likely already imports `accountsRoutes`, `makeApp`, `initAndLogin`, `db`, `instruments`):

```ts
test("creating an account seeds its currency instrument", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const res = await app.handle(new Request("http://localhost/accounts", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "DBS Savings", class: "asset", subtype: "bank", currency: "SGD" }),
  }));
  expect(res.status).toBe(200);
  const rows = await db.select().from(instruments).where(eq(instruments.kind, "currency"));
  expect(rows.some((r) => r.symbol === "SGD")).toBe(true);
});
```

Ensure the test file imports `instruments` from `../db/schema` and `eq` from `drizzle-orm` (add if missing). Delete any test asserting `GET /accounts` returns an opening-balance-derived `balanceMinor` that depended on the removed opening-entry behavior; a freshly created account now has `balanceMinor: 0` until transactions are added.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun test src/routes/accounts.test.ts`
Expected: FAIL — `valuation_mode` NOT NULL constraint or type errors from removed columns / missing seed.

- [ ] **Step 3: Implement the route changes**

In `apps/api/src/routes/accounts.ts`:

Replace the import block (lines 1-9) with:

```ts
import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { accounts, transactions, accountOwners, settings } from "../db/schema";
import { eq } from "drizzle-orm";
import { authGuard } from "../lib/auth-guard";
import { createId, nowEpoch } from "../lib/ids";
import { isUniqueViolation } from "../lib/db-errors";
import { accountValueMinor } from "../lib/valuation";
import { ensureCurrencyInstrument } from "../lib/instruments";
import { getAllOwnerSets, setOwners, allUsersExist } from "../lib/owners";
```

Replace the `GET "/"` handler (lines 13-23) with:

```ts
  .get("/", async () => {
    const s = (await db.select().from(settings).where(eq(settings.id, 1)))[0];
    const base = s?.baseCurrency ?? "USD";
    const rows = await db.select().from(accounts).orderBy(accounts.sortOrder);
    const ownerSets = await getAllOwnerSets();
    return Promise.all(
      rows.map(async (a) => ({
        ...a,
        balanceMinor: (await accountValueMinor(a.id, a.currency, base)).valueMinor,
        ownerIds: ownerSets.get(a.id) ?? [],
      })),
    );
  })
```

Replace the `POST "/"` handler body (the `async ({ body, userId, set }: any) => {…}` block, lines 26-78) with:

```ts
    async ({ body, userId, set }: any) => {
      const ownerIds: string[] =
        Array.isArray(body.ownerIds) && body.ownerIds.length > 0 ? body.ownerIds : [userId!];
      if (!(await allUsersExist(ownerIds))) {
        set.status = 422;
        return { error: "invalid_owner_ids" };
      }

      const id = body.id ?? createId();
      const currency = body.currency.toUpperCase();
      try {
        await db.insert(accounts).values({
          id,
          name: body.name,
          class: body.class,
          subtype: body.subtype,
          currency,
          institution: body.institution ?? null,
          isArchived: 0,
          sortOrder: body.sortOrder ?? 0,
          createdAt: nowEpoch(),
          createdBy: userId!,
          growthRateBps: body.growthRateBps ?? 0,
          accessibleFromAge: body.accessibleFromAge ?? 0,
          earlyWithdrawal: body.earlyWithdrawal === "penalty" ? "penalty" : "none",
          earlyHaircutBps: body.earlyHaircutBps ?? 0,
          illiquid: body.illiquid ? 1 : 0,
          liquidationAge: body.liquidationAge ?? null,
        });
      } catch (e) {
        if (isUniqueViolation(e)) {
          set.status = 409;
          return { error: "duplicate_id" };
        }
        throw e;
      }
      await setOwners(id, ownerIds);
      await ensureCurrencyInstrument(currency);
      return { id };
    },
```

In the `POST "/"` validator (lines 80-98), **remove** `valuationMode`, `openingBalanceMinor`, and `openingDate`. The resulting `body` object:

```ts
      body: t.Object({
        id: t.Optional(t.String()),
        name: t.String({ minLength: 1 }),
        class: t.Union([t.Literal("asset"), t.Literal("liability")]),
        subtype: t.String({ minLength: 1 }),
        currency: t.String({ pattern: "^[A-Za-z]{3}$" }),
        institution: t.Optional(t.String()),
        sortOrder: t.Optional(t.Number()),
        ownerIds: t.Optional(t.Array(t.String())),
        growthRateBps: t.Optional(t.Number()),
        accessibleFromAge: t.Optional(t.Number()),
        earlyWithdrawal: t.Optional(t.Union([t.Literal("none"), t.Literal("penalty")])),
        earlyHaircutBps: t.Optional(t.Number()),
        illiquid: t.Optional(t.Boolean()),
        liquidationAge: t.Optional(t.Union([t.Number(), t.Null()])),
      }),
```

In the `DELETE "/:id"` handler (lines 160-165), replace the two `entries`/`lots` deletes with a single `transactions` delete:

```ts
    await db
      .delete(accountOwners)
      .where(eq(accountOwners.accountId, params.id));
    await db.delete(transactions).where(eq(transactions.accountId, params.id));
    await db.delete(accounts).where(eq(accounts.id, params.id));
    return { ok: true };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && bun test src/routes/accounts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/accounts.ts apps/api/src/routes/accounts.test.ts
git commit -m "feat(api): accounts use positions valuation; seed currency; no valuationMode/opening"
```

---

### Task 11: Wire app; remove entries/lots routes; fix remaining API tests

**Files:**
- Modify: `apps/api/src/app.ts:6-15,46-56`
- Delete: `apps/api/src/routes/entries.ts`, `apps/api/src/routes/entries.test.ts`, `apps/api/src/routes/lots.ts`, `apps/api/src/routes/lots.test.ts`
- Verify: `apps/api/src/routes/networth.test.ts`, `apps/api/src/lib/networth-series.test.ts`, `apps/api/src/routes/networth-series.test.ts`

- [ ] **Step 1: Delete the obsolete routes and their tests**

```bash
git rm apps/api/src/routes/entries.ts apps/api/src/routes/entries.test.ts apps/api/src/routes/lots.ts apps/api/src/routes/lots.test.ts
```

- [ ] **Step 2: Update `app.ts`**

In `apps/api/src/app.ts`, replace the entries/lots imports (lines 6, 14) — delete:

```ts
import { entriesRoutes } from "./routes/entries";
import { lotsRoutes } from "./routes/lots";
```

and add:

```ts
import { transactionsRoutes } from "./routes/transactions";
import { positionsRoutes } from "./routes/positions";
```

In the `createApp()` chain, replace `.use(entriesRoutes)` (line 47) with `.use(transactionsRoutes)` and `.use(lotsRoutes)` (line 55) with `.use(positionsRoutes)`.

- [ ] **Step 3: Repair the net-worth tests**

The `networth.test.ts`, `lib/networth-series.test.ts`, and `routes/networth-series.test.ts` files seed accounts and balances. Update each:

- Remove `valuationMode` from any account insert/seed helper.
- Replace any balance seeding that used `entries` (opening/adjustment) or `lots` with the unified transactions pattern: seed a currency instrument and insert a `transactions` row. Use this helper shape (adapt the local seed helper in each file):

```ts
async function seedBalance(accountId: string, currency: string, amountMajor: number, date = "2026-01-01") {
  const S = Number(SCALE);
  const instrId = createId();
  await db.insert(instruments).values({
    id: instrId, symbol: currency, isin: null, name: currency, kind: "currency", currency, createdAt: nowEpoch(),
  });
  await db.insert(transactions).values({
    id: createId(), accountId, instrumentId: instrId, date,
    unitsDelta: Math.round(amountMajor * S), unitPriceScaled: S, feesMinor: 0, notes: null,
    createdAt: nowEpoch(), createdBy: "u",
  });
}
```

> To reuse one currency instrument across multiple accounts in a single test, hoist the `db.insert(instruments)` call out and pass the `instrId`. Each test asserts the same headline/series numbers as before — the public `netWorth`/`netWorthSeries` interface is unchanged, only the seeding mechanism differs.

Add imports `instruments`, `transactions` (from `../db/schema`) and `SCALE` (from `@uang/shared`) to each test file as needed; remove now-unused `entries`/`lots` imports.

- [ ] **Step 4: Run the whole API test suite**

Run: `cd apps/api && bun test`
Expected: PASS across all files. Fix any straggler that still references `entries`, `lots`, `valuationMode`, `accountBalanceMinor`, or `holdingsAccountValuation`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src
git commit -m "refactor(api): wire transactions/positions routes; remove entries/lots; fix tests"
```

---

## Phase 4 — Web data layer

### Task 12: Collections — transactions in, entries/lots out

**Files:**
- Modify: `apps/web/src/lib/collections.ts`

- [ ] **Step 1: Clean `AccountRow` (remove opening hints)**

In `apps/web/src/lib/collections.ts`, replace the `AccountRow` type (lines 31-36) with:

```ts
export type AccountRow = RowOf<typeof api.accounts.get>;
```

In `accountsCollection.onInsert` (lines 57-81), remove the now-invalid fields from the POST payload — delete the `valuationMode: m.valuationMode,`, `openingBalanceMinor: m.openingBalanceMinor,`, and `openingDate: m.openingDate,` lines.

- [ ] **Step 2: Remove the entries and lots collections**

Delete the `EntryRow` and `LotRow` type aliases (lines 39-40). Delete the entire `entriesCollection` factory block (lines 171-203) and the entire `lotsCollection` factory block (lines 205-263).

- [ ] **Step 3: Add the transactions collection**

Add this in place of the deleted blocks:

```ts
// ---------------------------------------------------------------------------
// transactionsCollection — factory, memoised per accountId
// ---------------------------------------------------------------------------

export type TransactionRow = RowOf<AccountApi["transactions"]["get"]>;

type TransactionsCollection = ReturnType<typeof _makeTransactionsCollection>;
const _transactionsCache = new Map<string, TransactionsCollection>();

function _makeTransactionsCollection(accountId: string) {
  return createCollection(
    queryCollectionOptions<TransactionRow, Error, [string, string], string>({
      queryKey: ["transactions", accountId],
      queryFn: async (): Promise<Array<TransactionRow>> => {
        const { data, error } = await api.accounts({ id: accountId }).transactions.get();
        if (error) throw new Error(String(error));
        return Array.isArray(data) ? data : [];
      },
      queryClient,
      getKey: (t) => t.id,
      onUpdate: async ({ transaction }) => {
        const m = transaction.mutations[0]?.modified as TransactionRow | undefined;
        if (!m) return;
        const { error } = await api.transactions({ id: m.id }).patch({
          date: m.date,
          unitsDelta: m.unitsDelta,
          unitPriceScaled: m.unitPriceScaled ?? undefined,
          feesMinor: m.feesMinor,
          notes: m.notes ?? undefined,
        });
        if (error) throw new Error(String(error));
      },
      onDelete: async ({ transaction }) => {
        const id = (transaction.mutations[0]?.original as TransactionRow | undefined)?.id;
        if (!id) return;
        await api.transactions({ id }).delete();
      },
    })
  );
}

export function transactionsCollection(accountId: string): TransactionsCollection {
  if (!_transactionsCache.has(accountId)) {
    _transactionsCache.set(accountId, _makeTransactionsCollection(accountId));
  }
  return _transactionsCache.get(accountId)!;
}
```

> Creation of transactions is done via a direct `api` call in the dialog (Task 13), not through this collection, because a buy with a cash leg writes two rows from one user action. The collection owns the live-query list, edits, and deletes.

- [ ] **Step 4: Typecheck the web app**

Run: `cd apps/web && bun run tsc --noEmit` (or the project's typecheck script — check `apps/web/package.json` `scripts`; commonly `bun run build` runs `tsc`).
Expected: errors ONLY in files still importing `entriesCollection`/`lotsCollection` (fixed in Phase 5). The `collections.ts` file itself must typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/collections.ts
git commit -m "feat(web): transactionsCollection; drop entries/lots collections"
```

---

## Phase 5 — Web UI

### Task 13: AddTransactionDialog (adaptive form)

**Files:**
- Create: `apps/web/src/components/add-transaction-dialog.tsx`

- [ ] **Step 1: Implement the dialog**

Create `apps/web/src/components/add-transaction-dialog.tsx`:

```tsx
import { useMemo, useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { useQueryClient } from "@tanstack/react-query";
import { SCALE, currencyDecimals } from "@uang/shared";
import { instrumentsCollection, transactionsCollection, newId, type InstrumentRow } from "@/lib/collections";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

const S = Number(SCALE);
const NEW_CURRENCY = "__new_currency__";
const NEW_INSTRUMENT = "__new_instrument__";
const today = () => new Date().toISOString().slice(0, 10);

export function AddTransactionDialog({ accountId, accountCurrency }: { accountId: string; accountCurrency: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data: instruments } = useLiveQuery(instrumentsCollection);

  const currencies = useMemo(() => (instruments ?? []).filter((i) => i.kind === "currency"), [instruments]);
  const securities = useMemo(() => (instruments ?? []).filter((i) => i.kind !== "currency"), [instruments]);

  // Default to the account's own currency instrument if present, else "new currency".
  const [instrumentId, setInstrumentId] = useState<string>("");
  const selected = (instruments ?? []).find((i) => i.id === instrumentId);
  const isCurrencyMode = instrumentId === NEW_CURRENCY || selected?.kind === "currency";

  const [newCurrency, setNewCurrency] = useState(accountCurrency);
  const [newInstr, setNewInstr] = useState({ name: "", symbol: "", currency: accountCurrency, kind: "stock" });

  // currency-mode fields
  const [amount, setAmount] = useState("");
  // security-mode fields
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [units, setUnits] = useState("");
  const [price, setPrice] = useState("");
  const [fees, setFees] = useState("");
  const [recordCash, setRecordCash] = useState(true);
  const [cashCurrencyId, setCashCurrencyId] = useState<string>("");

  const [date, setDate] = useState(today());
  const [notes, setNotes] = useState("");

  const amountNum = parseFloat(amount);
  const securityCurrency = instrumentId === NEW_INSTRUMENT ? newInstr.currency.toUpperCase() : selected?.currency ?? "USD";
  const cashAmount = (parseFloat(units) || 0) * (parseFloat(price) || 0) + (parseFloat(fees) || 0);

  function reset() {
    setInstrumentId(""); setAmount(""); setUnits(""); setPrice(""); setFees("");
    setSide("buy"); setRecordCash(true); setCashCurrencyId(""); setDate(today()); setNotes("");
    setNewInstr({ name: "", symbol: "", currency: accountCurrency, kind: "stock" });
    setNewCurrency(accountCurrency);
  }

  async function ensureCurrencyId(symbol: string): Promise<string> {
    const { data, error } = await api.instruments.currency.post({ symbol: symbol.toUpperCase() });
    if (error || !data || !("id" in data)) throw new Error(String(error ?? "currency create failed"));
    await instrumentsCollection.utils.refetch();
    return data.id;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();

    if (isCurrencyMode) {
      // Resolve the currency instrument id.
      let id = instrumentId;
      if (instrumentId === NEW_CURRENCY) id = await ensureCurrencyId(newCurrency);
      if (Number.isNaN(amountNum) || amountNum === 0) return;
      const { error } = await api.accounts({ id: accountId }).transactions.post({
        id: newId(),
        instrumentId: id,
        date,
        unitsDelta: Math.round(amountNum * S),
        unitPriceScaled: S,
        notes: notes || undefined,
      });
      if (error) throw new Error(String(error));
    } else {
      // Resolve the security instrument id.
      let id = instrumentId;
      if (instrumentId === NEW_INSTRUMENT) {
        const { data, error } = await api.instruments.post({
          name: newInstr.name,
          kind: newInstr.kind as InstrumentRow["kind"],
          currency: newInstr.currency.toUpperCase(),
          symbol: newInstr.symbol || undefined,
        });
        if (error || !data || !("id" in data)) throw new Error(String(error ?? "instrument create failed"));
        id = data.id;
        await instrumentsCollection.utils.refetch();
      }
      const u = parseFloat(units);
      const p = parseFloat(price);
      const fee = parseFloat(fees);
      if (Number.isNaN(u) || Number.isNaN(p)) return;
      const dec = currencyDecimals(securityCurrency);
      const signedUnits = side === "buy" ? u : -u;

      // Optional cash leg: a buy spends cash (negative), a sell receives cash (positive).
      let cashLeg: { instrumentId: string; unitsDelta: number } | undefined;
      if (recordCash) {
        const cashId = cashCurrencyId || (await ensureCurrencyId(securityCurrency));
        const cashUnits = side === "buy" ? -cashAmount : cashAmount;
        cashLeg = { instrumentId: cashId, unitsDelta: Math.round(cashUnits * S) };
      }

      const { error } = await api.accounts({ id: accountId }).transactions.post({
        id: newId(),
        instrumentId: id,
        date,
        unitsDelta: Math.round(signedUnits * S),
        unitPriceScaled: Math.round(p * S),
        feesMinor: Number.isNaN(fee) ? 0 : Math.round(fee * 10 ** dec),
        notes: notes || undefined,
        cashLeg,
      });
      if (error) throw new Error(String(error));
    }

    await transactionsCollection(accountId).utils.refetch();
    await qc.invalidateQueries({ queryKey: ["positions", accountId] });
    await qc.invalidateQueries({ queryKey: ["networth"] });
    setOpen(false);
    reset();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
      <DialogTrigger render={<Button />}>Add transaction</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add transaction</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <Label>Instrument</Label>
            <Select value={instrumentId} onValueChange={(v: string | null) => v && setInstrumentId(v)}>
              <SelectTrigger className="w-full" data-testid="tx-instrument">
                <SelectValue>
                  {(v: unknown) => {
                    const val = String(v);
                    if (val === NEW_CURRENCY) return "New currency…";
                    if (val === NEW_INSTRUMENT) return "New instrument…";
                    if (!val) return "Select instrument";
                    const i = (instruments ?? []).find((x) => x.id === val);
                    return i ? (i.symbol ? `${i.symbol} — ${i.name}` : i.name) : "Select";
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {/* Cash / currencies first */}
                {currencies.map((i) => (
                  <SelectItem key={i.id} value={i.id}>{i.symbol} — {i.name} (cash)</SelectItem>
                ))}
                <SelectItem value={NEW_CURRENCY}>New currency…</SelectItem>
                {securities.map((i) => (
                  <SelectItem key={i.id} value={i.id}>{i.symbol ? `${i.symbol} — ${i.name}` : i.name}</SelectItem>
                ))}
                <SelectItem value={NEW_INSTRUMENT}>New instrument…</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {instrumentId === NEW_CURRENCY && (
            <div>
              <Label>Currency code</Label>
              <Input data-testid="tx-new-currency" value={newCurrency} maxLength={3}
                     onChange={(e) => setNewCurrency(e.target.value)} required />
            </div>
          )}

          {instrumentId === NEW_INSTRUMENT && (
            <div className="grid grid-cols-2 gap-3 rounded-lg border border-border p-3">
              <div className="col-span-2">
                <Label>Name</Label>
                <Input data-testid="tx-instr-name" value={newInstr.name}
                       onChange={(e) => setNewInstr((p) => ({ ...p, name: e.target.value }))} required />
              </div>
              <div>
                <Label>Symbol</Label>
                <Input data-testid="tx-instr-symbol" value={newInstr.symbol}
                       onChange={(e) => setNewInstr((p) => ({ ...p, symbol: e.target.value }))} placeholder="optional" />
              </div>
              <div>
                <Label>Currency</Label>
                <Input data-testid="tx-instr-currency" value={newInstr.currency} maxLength={3}
                       onChange={(e) => setNewInstr((p) => ({ ...p, currency: e.target.value }))} required />
              </div>
              <div className="col-span-2">
                <Label>Kind</Label>
                <Select value={newInstr.kind} onValueChange={(v: string | null) => v && setNewInstr((p) => ({ ...p, kind: v }))}>
                  <SelectTrigger className="w-full"><SelectValue>{(v: unknown) => String(v)}</SelectValue></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="stock">stock</SelectItem>
                    <SelectItem value="etf">etf</SelectItem>
                    <SelectItem value="fund">fund</SelectItem>
                    <SelectItem value="crypto">crypto</SelectItem>
                    <SelectItem value="other">other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {isCurrencyMode ? (
            <div>
              <Label>Amount (+ add, − subtract)</Label>
              <Input data-testid="tx-amount" type="number" step="any" value={amount}
                     onChange={(e) => setAmount(e.target.value)}
                     className={cn("tabular-nums", !Number.isNaN(amountNum) && (amountNum < 0 ? "text-destructive" : "text-emerald-600"))}
                     required />
            </div>
          ) : (
            <>
              <div>
                <Label>Side</Label>
                <Select value={side} onValueChange={(v: string | null) => v && setSide(v as "buy" | "sell")}>
                  <SelectTrigger className="w-full" data-testid="tx-side"><SelectValue>{(v: unknown) => String(v) === "sell" ? "Sell" : "Buy"}</SelectValue></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="buy">Buy</SelectItem>
                    <SelectItem value="sell">Sell</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Units</Label>
                  <Input data-testid="tx-units" type="number" step="any" value={units} onChange={(e) => setUnits(e.target.value)} required />
                </div>
                <div>
                  <Label>Price ({securityCurrency})</Label>
                  <Input data-testid="tx-price" type="number" step="any" value={price} onChange={(e) => setPrice(e.target.value)} required />
                </div>
                <div>
                  <Label>Fees</Label>
                  <Input data-testid="tx-fees" type="number" step="any" value={fees} onChange={(e) => setFees(e.target.value)} placeholder="optional" />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={recordCash} onChange={(e) => setRecordCash(e.target.checked)} data-testid="tx-record-cash" />
                Also record cash {side === "buy" ? "outflow" : "inflow"} ({side === "buy" ? "−" : "+"}{cashAmount.toFixed(2)} {securityCurrency})
              </label>
              {recordCash && currencies.length > 0 && (
                <div>
                  <Label>Cash from</Label>
                  <Select value={cashCurrencyId} onValueChange={(v: string | null) => v && setCashCurrencyId(v)}>
                    <SelectTrigger className="w-full"><SelectValue>{(v: unknown) => {
                      const i = currencies.find((c) => c.id === String(v));
                      return i ? `${i.symbol} — ${i.name}` : `${securityCurrency} (auto)`;
                    }}</SelectValue></SelectTrigger>
                    <SelectContent>
                      {currencies.map((i) => (<SelectItem key={i.id} value={i.id}>{i.symbol} — {i.name}</SelectItem>))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Date</Label>
              <Input data-testid="tx-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
            </div>
            <div>
              <Label>Notes</Label>
              <Input data-testid="tx-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" />
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={!instrumentId}>Add</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

> The Eden path for the currency endpoint is `api.instruments.currency.post(...)`. If the generated client instead exposes it under a different accessor, adjust to match `apps/web/src/lib/api.ts` types (Eden mirrors the Elysia route tree). Verify in the typecheck step.

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && bun run tsc --noEmit`
Expected: this file typechecks (other UI files still pending in later tasks).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/add-transaction-dialog.tsx
git commit -m "feat(web): AddTransactionDialog (adaptive currency/security form)"
```

---

### Task 14: AccountHistory component

**Files:**
- Create: `apps/web/src/components/account-history.tsx`

- [ ] **Step 1: Implement**

Create `apps/web/src/components/account-history.tsx`:

```tsx
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import { formatMoney } from "@/components/money";
import { Eyebrow } from "@/components/app-layout";
import { Button } from "@/components/ui/button";
import { AddTransactionDialog } from "@/components/add-transaction-dialog";
import { UpdatePrice } from "@/components/update-price";
import { transactionsCollection } from "@/lib/collections";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

const SCALE = 100_000_000;
const fmtUnits = (scaled: number) => String(scaled / SCALE);

type Position = {
  instrument: { id: string; symbol: string | null; name: string; kind: string; currency: string };
  instrumentCurrency: string;
  units: number;
  currentPriceScaled: number | null;
  marketValueMinor: number;
  unrealizedGainMinor: number;
  valueDisplayMinor: number;
  missingPrice: boolean;
};

type Positions = {
  accountCurrency: string;
  baseCurrency: string;
  totalMinor: number;
  totalBaseMinor: number;
  missing: boolean;
  positions: Position[];
};

export function AccountHistory({ accountId, accountName, accountCurrency }: {
  accountId: string; accountName: string; accountCurrency: string;
}) {
  const qc = useQueryClient();

  const { data: pos, isLoading } = useQuery({
    queryKey: ["positions", accountId],
    queryFn: async (): Promise<Positions> => {
      const { data, error } = await api.accounts({ id: accountId }).positions.get();
      if (error) throw new Error(String(error));
      return data as unknown as Positions;
    },
  });

  const txCollection = transactionsCollection(accountId);
  const { data: txns } = useLiveQuery(txCollection);

  async function delTx(id: string) {
    await txCollection.delete(id);
    await qc.invalidateQueries({ queryKey: ["positions", accountId] });
    await qc.invalidateQueries({ queryKey: ["networth"] });
  }

  const positions = (pos?.positions ?? []).filter((p) => p.units > 0);
  const sortedTxns = [...(txns ?? [])].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  return (
    <>
      <header>
        <Eyebrow>{accountCurrency} · account</Eyebrow>
        <h1 className="mt-2 font-heading text-3xl tracking-tight">{accountName}</h1>
        <p data-testid="account-total" className="mt-1 font-heading text-4xl tabular-nums tracking-tight">
          {isLoading || !pos ? "—" : formatMoney(pos.totalMinor, accountCurrency)}
        </p>
        {pos && pos.missing && (
          <p className="mt-1 text-sm text-destructive">Some positions are missing a price or FX rate.</p>
        )}
      </header>

      <div className="mt-5">
        <AddTransactionDialog accountId={accountId} accountCurrency={accountCurrency} />
      </div>

      <section className="mt-9">
        <Eyebrow className="mb-3">Positions</Eyebrow>
        {positions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No positions yet. Use "Add transaction" to record activity.</p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            {positions.map((p, i) => {
              const isCash = p.instrument.kind === "currency";
              return (
                <div key={p.instrument.id} data-testid="position-row"
                     className={cn("group flex items-center justify-between gap-4 px-4 py-3", i > 0 && "border-t border-border/70")}>
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      {p.instrument.symbol ? `${p.instrument.symbol} · ` : ""}{p.instrument.name}
                      <span className="ml-2 rounded-full bg-muted px-1.5 py-0.5 text-[0.65rem] font-medium text-muted-foreground">
                        {isCash ? "cash" : p.instrument.kind}
                      </span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {fmtUnits(p.units)} {isCash ? p.instrument.currency : "units"}
                      {p.missingPrice && <span className="ml-1.5 rounded-full bg-destructive/10 px-1.5 py-0.5 text-[0.65rem] font-medium text-destructive">no price</span>}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="shrink-0 text-right tabular-nums">
                      <p className="font-medium">{p.missingPrice ? "—" : formatMoney(p.valueDisplayMinor, accountCurrency)}</p>
                      {!isCash && !p.missingPrice && (
                        <p className={cn("text-xs", p.unrealizedGainMinor < 0 ? "text-destructive" : "text-muted-foreground")}>
                          {p.unrealizedGainMinor >= 0 ? "+" : ""}{formatMoney(p.unrealizedGainMinor, p.instrumentCurrency)}
                        </p>
                      )}
                    </div>
                    {!isCash && (
                      <div className="opacity-0 transition-opacity group-hover:opacity-100">
                        <UpdatePrice instrumentId={p.instrument.id} accountId={accountId} label="Price" />
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="mt-9">
        <Eyebrow className="mb-3">History</Eyebrow>
        {sortedTxns.length === 0 ? (
          <p className="text-sm text-muted-foreground">No transactions yet.</p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            {sortedTxns.map((t, i) => {
              const isCash = t.instrument.kind === "currency";
              const amountMajor = t.unitsDelta / SCALE;
              return (
                <div key={t.id} data-testid="tx-row"
                     className={cn("group flex items-center justify-between gap-4 px-4 py-3", i > 0 && "border-t border-border/70")}>
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      {t.instrument.symbol ? `${t.instrument.symbol} · ` : ""}{t.instrument.name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t.date}{t.notes ? ` · ${t.notes}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <p className={cn("shrink-0 tabular-nums", t.unitsDelta < 0 && "text-destructive")}>
                      {t.unitsDelta >= 0 ? "+" : ""}{amountMajor} {isCash ? t.instrument.currency : "units"}
                    </p>
                    <Button variant="ghost" size="sm"
                            className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
                            onClick={() => delTx(t.id)}>
                      Delete
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && bun run tsc --noEmit`
Expected: this file typechecks.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/account-history.tsx
git commit -m "feat(web): AccountHistory component (positions + history)"
```

---

### Task 15: Account detail page — single unified view

**Files:**
- Modify: `apps/web/src/routes/account-detail.tsx`

- [ ] **Step 1: Rewrite the page**

Replace `apps/web/src/routes/account-detail.tsx` entirely with:

```tsx
import { useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { subtypeLabel, classLabel } from "@/components/labels";
import { AppShell, Eyebrow } from "@/components/app-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { accountsCollection } from "@/lib/collections";
import { api } from "@/lib/api";
import { OwnersField } from "@/components/owners-field";
import { OwnersBadge } from "@/components/owners-badge";
import { AccountHistory } from "@/components/account-history";
import { AccountAssumptionsDialog } from "@/components/account-assumptions-dialog";
import { EditAccountInline } from "@/components/edit-account-inline";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";

const BackButton = () => (
  <Link to="/">
    <Button variant="ghost" size="sm">← Back</Button>
  </Link>
);

export function AccountDetailPage() {
  const { id } = useParams({ from: "/accounts/$id" });
  const nav = useNavigate();
  const qc = useQueryClient();
  const [editingOwners, setEditingOwners] = useState(false);
  const [draftOwners, setDraftOwners] = useState<string[]>([]);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteName, setDeleteName] = useState("");

  const { data: accounts, isLoading: accountsLoading } = useLiveQuery(accountsCollection);
  const account = (accounts ?? []).find((a) => a.id === id);

  if (accountsLoading || !account) {
    return (
      <AppShell actions={<BackButton />}>
        <p className="text-muted-foreground">{accountsLoading ? "Loading…" : "Account not found."}</p>
      </AppShell>
    );
  }

  async function archiveAccount() {
    await accountsCollection.update(account!.id, (draft) => { draft.isArchived = 1; });
    await qc.invalidateQueries({ queryKey: ["networth"] });
  }
  async function restoreAccount() {
    await accountsCollection.update(account!.id, (draft) => { draft.isArchived = 0; });
    await qc.invalidateQueries({ queryKey: ["networth"] });
  }
  async function deleteAccount() {
    await accountsCollection.delete(account!.id);
    await qc.invalidateQueries({ queryKey: ["networth"] });
    await nav({ to: "/" });
  }
  async function saveOwners() {
    if (draftOwners.length === 0) return;
    await api.accounts({ id }).owners.patch({ ownerIds: draftOwners });
    await qc.invalidateQueries({ queryKey: ["accounts"] });
    await qc.invalidateQueries({ queryKey: ["networth"] });
    setEditingOwners(false);
  }

  const dangerZone = (
    <section className="mt-12 border-t border-border pt-6">
      <Eyebrow className="mb-3 text-destructive">Danger zone</Eyebrow>
      {account.isArchived === 0 ? (
        <div className="flex items-center justify-between rounded-xl border border-border bg-card px-4 py-3">
          <div>
            <p className="text-sm font-medium">Archive account</p>
            <p className="text-xs text-muted-foreground">Hides it from the dashboard. You can restore it later.</p>
          </div>
          <Button variant="outline" size="sm" onClick={archiveAccount}>Archive</Button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-xl border border-border bg-card px-4 py-3">
            <div>
              <p className="text-sm font-medium">Restore account</p>
              <p className="text-xs text-muted-foreground">Makes it visible on the dashboard again.</p>
            </div>
            <Button variant="outline" size="sm" onClick={restoreAccount}>Restore</Button>
          </div>
          <div className="flex items-center justify-between rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3">
            <div>
              <p className="text-sm font-medium text-destructive">Delete permanently</p>
              <p className="text-xs text-muted-foreground">Removes all history. Cannot be undone.</p>
            </div>
            <Dialog open={deleteOpen} onOpenChange={(o) => { setDeleteOpen(o); if (!o) setDeleteName(""); }}>
              <DialogTrigger render={<Button variant="destructive" size="sm" />}>Delete permanently</DialogTrigger>
              <DialogContent>
                <DialogHeader><DialogTitle>Delete "{account.name}" permanently?</DialogTitle></DialogHeader>
                <p className="text-sm text-muted-foreground">This deletes the account and all its history. Type the account name to confirm.</p>
                <Input value={deleteName} onChange={(e) => setDeleteName(e.target.value)} placeholder={account.name} />
                <DialogFooter>
                  <Button variant="destructive" disabled={deleteName !== account.name} onClick={deleteAccount}>Delete permanently</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </div>
      )}
    </section>
  );

  return (
    <AppShell
      actions={
        <div className="flex items-center gap-2">
          <AccountAssumptionsDialog account={account} />
          <BackButton />
        </div>
      }
    >
      {account.isArchived === 1 && (
        <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
          This account is archived and hidden from the dashboard.
        </div>
      )}

      <div className="mb-4">
        <Eyebrow>{classLabel(account.class)} · {subtypeLabel(account.subtype)}</Eyebrow>
      </div>

      <AccountHistory accountId={id} accountName={account.name} accountCurrency={account.currency} />

      <section className="mt-6">
        <EditAccountInline account={account} />
      </section>

      <section className="mt-4">
        {!editingOwners ? (
          <div className="flex items-center gap-3">
            <OwnersBadge ownerIds={account.ownerIds} />
            <Button variant="ghost" size="sm" onClick={() => { setDraftOwners(account!.ownerIds); setEditingOwners(true); }}>
              Edit owners
            </Button>
          </div>
        ) : (
          <div className="max-w-xs space-y-3 rounded-xl border border-border bg-card p-4">
            <Eyebrow>Owners</Eyebrow>
            <OwnersField value={draftOwners} onChange={setDraftOwners} />
            <div className="flex gap-2">
              <Button size="sm" onClick={saveOwners} disabled={draftOwners.length === 0}>Save</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditingOwners(false)}>Cancel</Button>
            </div>
          </div>
        )}
      </section>

      {dangerZone}
    </AppShell>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && bun run tsc --noEmit`
Expected: errors only in `account-form.tsx` (valuationMode), `holdings-detail.tsx`, `set-balance-dialog.tsx`, `add-lot-dialog.tsx`, `update-price.tsx`, and `labels.ts` consumers — fixed next.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/account-detail.tsx
git commit -m "feat(web): unified account detail via AccountHistory"
```

---

### Task 16: Simplify account form; clean labels; fix update-price; delete dead components

**Files:**
- Modify: `apps/web/src/components/account-form.tsx`
- Modify: `apps/web/src/components/labels.ts:19-27`
- Modify: `apps/web/src/components/update-price.tsx:44`
- Delete: `apps/web/src/components/holdings-detail.tsx`, `set-balance-dialog.tsx`, `add-lot-dialog.tsx`

- [ ] **Step 1: Delete dead components**

```bash
git rm apps/web/src/components/holdings-detail.tsx apps/web/src/components/set-balance-dialog.tsx apps/web/src/components/add-lot-dialog.tsx
```

- [ ] **Step 2: Clean `labels.ts`**

In `apps/web/src/components/labels.ts`, delete the `KIND_LABELS` map and `kindLabel` export (lines 19-27). Add instrument-kind labels in their place:

```ts
// Instrument kinds, humanized (used for position badges).
export const INSTRUMENT_KIND_LABELS: Record<string, string> = {
  currency: "Cash", stock: "Stock", etf: "ETF", fund: "Fund", crypto: "Crypto", other: "Other",
};

export const instrumentKindLabel = (k: string): string => INSTRUMENT_KIND_LABELS[k] ?? k;
```

- [ ] **Step 3: Fix `update-price.tsx` invalidation**

In `apps/web/src/components/update-price.tsx`, line 44, change:

```ts
    await qc.invalidateQueries({ queryKey: ["holdings", accountId] });
```

to:

```ts
    await qc.invalidateQueries({ queryKey: ["positions", accountId] });
```

- [ ] **Step 4: Simplify `account-form.tsx`**

In `apps/web/src/components/account-form.tsx`:

1. Remove `valuationMode`, `openingBalance`, `openingDate` from the `useState` initializer (lines 32-40). New initializer:

```ts
  const [f, setF] = useState({
    name: "",
    class: "asset",
    subtype: "bank",
    currency: defaultCurrency ?? "USD",
  });
```

2. In `submit` (lines 47-84), remove the opening-balance computation and the `valuationMode` field on the row, and remove the `openingBalanceMinor`/`openingDate` block. The body becomes:

```ts
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const currency = f.currency.toUpperCase();
    const assumptions = defaultAssumptions(f.subtype);
    const row: AccountRow = {
      id: newId(),
      name: f.name,
      class: f.class as AccountRow["class"],
      subtype: f.subtype,
      currency,
      institution: null,
      isArchived: 0,
      sortOrder: 0,
      balanceMinor: 0,
      createdAt: Math.floor(Date.now() / 1000),
      createdBy: meId ?? "",
      ownerIds: owners.length > 0 ? owners : meId ? [meId] : [],
      growthRateBps: assumptions.growthRateBps,
      accessibleFromAge: assumptions.accessibleFromAge,
      earlyWithdrawal: assumptions.earlyWithdrawal,
      earlyHaircutBps: assumptions.earlyHaircutBps,
      illiquid: assumptions.illiquid ? 1 : 0,
      liquidationAge: assumptions.liquidationAge,
    };
    await accountsCollection.insert(row);
    await qc.invalidateQueries({ queryKey: ["networth"] });
    setOpen(false);
    setF((prev) => ({ ...prev, name: "" }));
  }
```

3. In the subtype `Select` `onValueChange` (lines 139-146), remove the `valuationMode` derivation — set only `subtype`:

```ts
                onValueChange={(v: string | null) => {
                  if (!v) return;
                  set("subtype", v);
                }}
```

4. Delete the entire **Valuation** `<div>` select block (lines 163-182) and both **opening balance / opening date** blocks (lines 197-220). Remove the now-unused `currencyDecimals` import (line 3) if nothing else uses it.

- [ ] **Step 5: Typecheck and lint the whole web app**

Run: `cd apps/web && bun run tsc --noEmit`
Expected: PASS, no remaining references to `valuationMode`, `kindLabel`, `holdings-detail`, `set-balance-dialog`, `add-lot-dialog`, `entriesCollection`, or `lotsCollection`. Grep to confirm:

Run: `cd apps/web && grep -rn "valuationMode\|kindLabel\|holdings-detail\|set-balance\|add-lot\|entriesCollection\|lotsCollection" src/ || echo CLEAN`
Expected: `CLEAN`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src
git commit -m "refactor(web): simplify account form; drop holdings/ledger split components"
```

---

### Task 17: Manual smoke check of the running app

**Files:** none (verification only)

- [ ] **Step 1: Start the stack and exercise the flow**

Use the `/run` skill (or start API + web manually). Then verify in the browser:
1. Create an account "DBS Savings" in SGD (no valuation/opening fields shown).
2. Open it → "Add transaction" → currency mode → the seeded SGD instrument is pre-listed → add `+1000`. Confirm the SGD cash position shows 1,000.00 and the History row shows `+1000 SGD`.
3. Create a "Brokerage" account in USD. Add a transaction → "New instrument…" AAPL/USD, Buy 10 @ 100, leave "Also record cash outflow" checked. Confirm two positions appear (AAPL with "no price"; a negative USD cash position) and two history rows.
4. Hover the AAPL position → "Price" → set 120. Confirm AAPL value 1,200.00 and +200.00 gain.
5. Back to dashboard → net-worth headline includes both accounts.

Expected: all steps work. If anything fails, debug with `superpowers:systematic-debugging` before continuing.

- [ ] **Step 2: Commit (if any fixes were needed)**

```bash
git add -A && git commit -m "fix(web): address manual smoke findings"
```

(Skip if no changes.)

---

## Phase 6 — E2E

### Task 18: Update e2e helpers

**Files:**
- Modify: `e2e/tests/helpers.ts:30-42`

- [ ] **Step 1: Replace `createLedgerAccount` with a generic `createAccount`**

In `e2e/tests/helpers.ts`, replace the `createLedgerAccount` function (lines 30-42) with:

```ts
// Open the "Add account" dialog from the dashboard and create an account.
export async function createAccount(
  page: Page,
  opts: { name: string; currency?: string },
) {
  await page.getByRole("button", { name: "Add account" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByTestId("account-name").fill(opts.name);
  await dialog.getByTestId("account-currency").fill(opts.currency ?? "USD");
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(dialog).toBeHidden();
}
```

- [ ] **Step 2: Commit**

```bash
git add e2e/tests/helpers.ts
git commit -m "test(e2e): generic createAccount helper (no valuation/opening)"
```

---

### Task 19: Rewrite accounts.spec; replace holdings.spec with transactions.spec

**Files:**
- Modify: `e2e/tests/accounts.spec.ts`
- Delete: `e2e/tests/holdings.spec.ts`
- Create: `e2e/tests/transactions.spec.ts`

- [ ] **Step 1: Rewrite `accounts.spec.ts`**

Replace `e2e/tests/accounts.spec.ts` entirely with:

```ts
import { test, expect } from "./fixtures";
import { seedHousehold, createAccount } from "./helpers";

test.beforeEach(async ({ backend, request, context }) => {
  await backend.freshDb();
  await seedHousehold(request, context, backend.apiURL);
});

test("create a cash account and add a currency transaction", async ({ page }) => {
  await page.goto("/");

  await test.step("create the account", async () => {
    await createAccount(page, { name: "Checking", currency: "USD" });
  });

  await test.step("open it and add a cash deposit", async () => {
    await page.reload();
    await page.getByTestId("account-row").filter({ hasText: "Checking" }).click();
    await expect(page).toHaveURL(/\/accounts\//);

    await page.getByRole("button", { name: "Add transaction" }).click();
    const dialog = page.getByRole("dialog");
    // Pick the auto-seeded USD currency instrument.
    await dialog.getByTestId("tx-instrument").click();
    await page.getByRole("option", { name: /USD .* \(cash\)/ }).click();
    await dialog.getByTestId("tx-amount").fill("1000");
    await dialog.getByRole("button", { name: "Add" }).click();
    await expect(dialog).toBeHidden();
  });

  await test.step("the position and account total reflect the deposit", async () => {
    await page.reload();
    await expect(page.getByTestId("account-total")).toContainText("1,000.00");
    await expect(page.getByTestId("position-row").filter({ hasText: "USD" })).toBeVisible();
  });

  await test.step("it rolls into the dashboard net worth", async () => {
    await page.getByRole("link", { name: "← Back" }).click();
    await expect(page.getByTestId("networth-hero")).toContainText("1,000.00");
  });
});
```

- [ ] **Step 2: Delete the old holdings spec**

```bash
git rm e2e/tests/holdings.spec.ts
```

- [ ] **Step 3: Create `transactions.spec.ts`**

Create `e2e/tests/transactions.spec.ts`:

```ts
import { test, expect } from "./fixtures";
import { seedHousehold, createAccount } from "./helpers";

test.beforeEach(async ({ backend, request, context }) => {
  await backend.freshDb();
  await seedHousehold(request, context, backend.apiURL);
});

test("buy a stock with a cash leg, set price, see value and gain roll up", async ({ page }) => {
  await page.goto("/");

  await test.step("create a USD brokerage account", async () => {
    await createAccount(page, { name: "Brokerage", currency: "USD" });
  });

  await test.step("buy a new instrument with the cash leg", async () => {
    await page.reload();
    await page.getByTestId("account-row").filter({ hasText: "Brokerage" }).click();
    await page.getByRole("button", { name: "Add transaction" }).click();
    const dialog = page.getByRole("dialog");

    await dialog.getByTestId("tx-instrument").click();
    await page.getByRole("option", { name: "New instrument…" }).click();
    await dialog.getByTestId("tx-instr-name").fill("Acme Corp");
    await dialog.getByTestId("tx-instr-symbol").fill("ACME");
    await dialog.getByTestId("tx-instr-currency").fill("USD");
    await dialog.getByTestId("tx-units").fill("10");
    await dialog.getByTestId("tx-price").fill("100");
    // "Also record cash outflow" is checked by default.
    await dialog.getByRole("button", { name: "Add" }).click();
    await expect(dialog).toBeHidden();
  });

  await test.step("two positions appear; the stock has no price yet", async () => {
    await page.reload();
    await expect(page.getByTestId("position-row").filter({ hasText: "Acme Corp" })).toContainText("no price");
    await expect(page.getByTestId("position-row").filter({ hasText: "USD" })).toBeVisible();
  });

  await test.step("set a price → market value and gain appear", async () => {
    const row = page.getByTestId("position-row").filter({ hasText: "Acme Corp" });
    await row.getByRole("button", { name: "Price" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByTestId("price-amount").fill("120");
    await dialog.getByRole("button", { name: "Save price" }).click();
    await expect(dialog).toBeHidden();
    await page.reload();
    const priced = page.getByTestId("position-row").filter({ hasText: "Acme Corp" });
    await expect(priced).toContainText("1,200.00"); // 10 × 120
    await expect(priced).toContainText("200.00");    // (120-100) × 10
  });

  await test.step("net worth nets stock value against the cash outflow", async () => {
    // +1,200 stock − 1,000 cash = 200.00
    await page.getByRole("link", { name: "← Back" }).click();
    await expect(page.getByTestId("networth-hero")).toContainText("200.00");
  });
});
```

- [ ] **Step 4: Run the e2e suite**

Run: `cd e2e && bunx playwright test accounts.spec.ts transactions.spec.ts` (or the project's e2e script — check `e2e/package.json`).
Expected: PASS. Debug failures with `superpowers:systematic-debugging`; common issues are `getByRole("option")` text not matching the rendered `SelectItem` label — adjust the matcher to the actual text.

- [ ] **Step 5: Check the other e2e specs still pass**

Run: `cd e2e && bunx playwright test`
Expected: PASS. `networth-graph.spec.ts`, `ownership.spec.ts`, `smoke.spec.ts` may reference `createLedgerAccount` or opening balances — update them to use `createAccount` + an "Add transaction" deposit where they previously relied on an opening balance. Apply the same patterns as above.

- [ ] **Step 6: Commit**

```bash
git add e2e
git commit -m "test(e2e): transactions-based account + buy/sell flows"
```

---

### Task 20: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run everything**

Run from repo root: `bun test` in `apps/api` and `packages/shared`, `bun run tsc --noEmit` in `apps/web`, and the full Playwright suite in `e2e`.
Expected: all green.

- [ ] **Step 2: Final grep for dead references across the repo**

Run: `grep -rn "valuationMode\|valuation_mode\|holdingsAccountValuation\|accountBalanceMinor\|\\blots\\b\|\\bentries\\b" apps/ packages/ e2e/ --include=*.ts --include=*.tsx | grep -v drizzle/ || echo CLEAN`
Expected: `CLEAN` (or only legitimate hits — e.g. an unrelated local variable named `entries`). Investigate anything in `schema.ts`, routes, or collections.

- [ ] **Step 3: Update the build-status memory**

Update `/Users/aziz/.claude/projects/-Users-aziz-Workspace-uang/memory/uang-build-status.md` to note unified transactions shipped (entries/lots/valuationMode removed; single `transactions` table; `AccountHistory` UI).

- [ ] **Step 4: Finish the branch**

Use `superpowers:finishing-a-development-branch` to decide merge/PR.

---

## Self-Review

**Spec coverage:**
- `transactions` table replacing entries+lots → Task 3, 8. ✅
- `instruments.kind: "currency"` + auto-seed → Task 3, 6, 10 (account create seeds), 7 (currency endpoint). ✅
- Drop `valuationMode`, opening balance, set-balance, revalue → Task 3, 10, 11, 16. ✅
- Computed positions / avg cost / unrealized gain / account value → Task 4, 5, 9. ✅
- Routes: transactions (list/create/edit/delete), positions, instruments currency, removed entries/lots → Tasks 7-11. ✅
- Net worth same interface, simpler impl → Task 5, 11 (series unchanged). ✅
- UI: single `AccountHistory` (positions + history), adaptive add-transaction form with cash-leg checkbox → Tasks 13-15. ✅
- FX at net-worth layer only → Task 5 (`convertMinor`). ✅
- Migration = fresh schema, discard data → Task 3. ✅

**Type consistency:** `accountValueMinor(accountId, target, base, asOf?)` and `convertMinor(amount, from, to, base, asOf?)` signatures are used identically in valuation.ts, positions route, and accounts route. `Position` fields (`marketValueMinor`, `unrealizedGainMinor`, `valueDisplayMinor`, `missingPrice`, `instrumentCurrency`) match across the positions lib, positions route, and `AccountHistory`. `TransactionRow` shape (with embedded `instrument`) matches the GET handler in Task 8 and the collection in Task 12. No `as any` introduced (only the sanctioned Elysia `: any` context pattern).

**Placeholder scan:** no TBD/TODO; every code step contains full code. Two pre-flagged adaptation points (Eden `api.instruments.currency` accessor in Task 13; `db.transaction` driver fallback in Task 8) are explicit, with concrete fallbacks — not placeholders.
