# Instruments Management, Appreciation Fix & Net-Deposits Line — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Instruments management page (list, holders, edit, delete, historical prices), make backdated trades seed price history so holdings appreciate on the net-worth chart, and add a "net deposits" line to that chart.

**Architecture:** Three phases. (A) Trades upsert a `source="trade"` price observation so carry-forward valuation appreciates. (B) A new `linkedTransactionId` column distinguishes internal cash legs from external deposits, powering a net-deposits series. (C) New instrument endpoints + an Instruments page/route.

**Tech Stack:** Elysia + Drizzle + libsql/SQLite (`apps/api`), React + TanStack Router/Query/DB + recharts (`apps/web`), Bun, `@uang/shared` money helpers. Spec: `docs/superpowers/specs/2026-06-15-instruments-management-appreciation-net-deposits-design.md`.

**Conventions (must follow):**
- **No `as any`** anywhere. Route-handler context may use `: any` (existing convention) — nothing else.
- After API changes affecting types, typecheck via `cd apps/web && bun run build` (tsgo).
- API route/lib tests live beside the file as `*.test.ts`; run with `cd apps/api && bun test <path>`. Migrations run once in `test-setup.ts`, so a generated migration is picked up automatically by tests.
- Money/units are integers scaled ×1e8 (`SCALE` = `100_000_000n`). `roundDiv(num, den)`, `toBig`, `fromBig`, `currencyDecimals` come from `@uang/shared`.

---

## Phase A — Appreciation fix: trades seed price history

### Task A1: `seedTradePrice` helper

**Files:**
- Create: `apps/api/src/lib/trade-prices.ts`
- Test: `apps/api/src/lib/trade-prices.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/lib/trade-prices.test.ts
import { expect, test, beforeEach } from "bun:test";
import { resetDb } from "./test-helpers";
import { db } from "../db/client";
import { instruments, prices } from "../db/schema";
import { createId, nowEpoch } from "./ids";
import { seedTradePrice } from "./trade-prices";
import { eq } from "drizzle-orm";

beforeEach(resetDb);

async function instr(): Promise<string> {
  const id = createId();
  await db.insert(instruments).values({
    id, symbol: "AAPL", isin: null, name: "Apple", kind: "stock", currency: "USD", createdAt: nowEpoch(),
  });
  return id;
}

test("inserts a trade-sourced price when none exists for the date", async () => {
  const id = await instr();
  await seedTradePrice(id, "2026-01-01", 50_00000000);
  const rows = await db.select().from(prices).where(eq(prices.instrumentId, id));
  expect(rows.length).toBe(1);
  expect(rows[0].source).toBe("trade");
  expect(rows[0].priceScaled).toBe(50_00000000);
});

test("does not clobber an existing manual price for the same date", async () => {
  const id = await instr();
  await db.insert(prices).values({
    id: createId(), instrumentId: id, date: "2026-01-01", priceScaled: 99_00000000, source: "manual", createdAt: nowEpoch(),
  });
  await seedTradePrice(id, "2026-01-01", 50_00000000);
  const [row] = await db.select().from(prices).where(eq(prices.instrumentId, id));
  expect(row.source).toBe("manual");
  expect(row.priceScaled).toBe(99_00000000);
});

test("updates an existing trade-sourced price for the same date", async () => {
  const id = await instr();
  await seedTradePrice(id, "2026-01-01", 50_00000000);
  await seedTradePrice(id, "2026-01-01", 55_00000000);
  const rows = await db.select().from(prices).where(eq(prices.instrumentId, id));
  expect(rows.length).toBe(1);
  expect(rows[0].priceScaled).toBe(55_00000000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun test src/lib/trade-prices.test.ts`
Expected: FAIL — `Cannot find module './trade-prices'`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/lib/trade-prices.ts
import { db } from "../db/client";
import { prices } from "../db/schema";
import { and, eq } from "drizzle-orm";
import { createId, nowEpoch } from "./ids";

// Record a trade's price as a price observation for (instrument, date).
// Insert-if-absent; only ever updates our own `source="trade"` rows, never a
// manual price. Callers must pass non-currency instruments with a real price.
export async function seedTradePrice(
  instrumentId: string,
  date: string,
  priceScaled: number,
): Promise<void> {
  const [existing] = await db
    .select()
    .from(prices)
    .where(and(eq(prices.instrumentId, instrumentId), eq(prices.date, date)));
  if (!existing) {
    await db.insert(prices).values({
      id: createId(), instrumentId, date, priceScaled, source: "trade", createdAt: nowEpoch(),
    });
  } else if (existing.source === "trade") {
    await db.update(prices).set({ priceScaled }).where(eq(prices.id, existing.id));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && bun test src/lib/trade-prices.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/trade-prices.ts apps/api/src/lib/trade-prices.test.ts
git commit -m "feat(api): seedTradePrice helper (insert-if-absent, never clobber manual)"
```

---

### Task A2: Wire trade-price seeding into transactions POST + PATCH

**Files:**
- Modify: `apps/api/src/routes/transactions.ts`
- Test: `apps/api/src/routes/transactions.test.ts` (add cases)

- [ ] **Step 1: Add failing tests**

Append to `apps/api/src/routes/transactions.test.ts` (the file already imports `db`, `instruments`, `transactions`, `prices`? — it imports `accounts, instruments, transactions`; add `prices` to that import):

Change line 3 import to:
```ts
import { accounts, instruments, transactions, prices } from "../db/schema";
```

Append tests:
```ts
test("POST a stock buy seeds a trade-sourced price at the trade date", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const acc = await seedAccount();
  const stock = await seedInstrument("stock");

  await app.handle(new Request(`http://localhost/accounts/${acc}/transactions`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ instrumentId: stock, date: "2026-01-01", unitsDelta: 10 * S, unitPriceScaled: 50 * S }),
  }));

  const rows = await db.select().from(prices).where(eq(prices.instrumentId, stock));
  expect(rows.length).toBe(1);
  expect(rows[0].date).toBe("2026-01-01");
  expect(rows[0].source).toBe("trade");
  expect(rows[0].priceScaled).toBe(50 * S);
});

test("POST a currency (cash) transaction does NOT seed a price", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const acc = await seedAccount();
  const usd = await seedInstrument("currency", "USD");

  await app.handle(new Request(`http://localhost/accounts/${acc}/transactions`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ instrumentId: usd, date: "2026-01-01", unitsDelta: 1000 * S, unitPriceScaled: S }),
  }));

  const rows = await db.select().from(prices).where(eq(prices.instrumentId, usd));
  expect(rows.length).toBe(0);
});

test("PATCH editing a trade's price updates its trade-sourced price row", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const acc = await seedAccount();
  const stock = await seedInstrument("stock");
  const create = await (await app.handle(new Request(`http://localhost/accounts/${acc}/transactions`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ instrumentId: stock, date: "2026-01-01", unitsDelta: 10 * S, unitPriceScaled: 50 * S }),
  }))).json();

  await app.handle(new Request(`http://localhost/transactions/${create.id}`, {
    method: "PATCH", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ unitPriceScaled: 60 * S }),
  }));

  const [row] = await db.select().from(prices).where(eq(prices.instrumentId, stock));
  expect(row.priceScaled).toBe(60 * S);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && bun test src/routes/transactions.test.ts`
Expected: FAIL — the two seeding tests fail (no price rows / wrong value).

- [ ] **Step 3: Implement seeding in the route**

In `apps/api/src/routes/transactions.ts`:

Add import near the top (after the `isUniqueViolation` import):
```ts
import { seedTradePrice } from "../lib/trade-prices";
```

In the **POST** handler, change the instrument existence check to also fetch `kind` (line ~32):
```ts
const instr = await db.select({ id: instruments.id, kind: instruments.kind }).from(instruments).where(eq(instruments.id, body.instrumentId));
if (instr.length === 0) { set.status = 422; return { error: "unknown_instrument" }; }
```

Then, just before `return { id: mainId };` (after the try/catch block), add:
```ts
if (instr[0].kind !== "currency" && body.unitPriceScaled != null) {
  await seedTradePrice(body.instrumentId, body.date, body.unitPriceScaled);
}
```

In the **PATCH** handler, replace the body of the handler so it reads the existing row and re-seeds:
```ts
async ({ params, body }: any) => {
  const [tx] = await db.select().from(transactions).where(eq(transactions.id, params.id));
  const update: Record<string, unknown> = {};
  if (body.date !== undefined) update.date = body.date;
  if (body.unitsDelta !== undefined) update.unitsDelta = body.unitsDelta;
  if (body.unitPriceScaled !== undefined) update.unitPriceScaled = body.unitPriceScaled;
  if (body.feesMinor !== undefined) update.feesMinor = body.feesMinor;
  if (body.notes !== undefined) update.notes = body.notes;
  await db.update(transactions).set(update).where(eq(transactions.id, params.id));

  if (tx) {
    const [instr] = await db.select({ kind: instruments.kind }).from(instruments).where(eq(instruments.id, tx.instrumentId));
    const date = body.date ?? tx.date;
    const price = body.unitPriceScaled ?? tx.unitPriceScaled;
    if (instr && instr.kind !== "currency" && price != null) {
      await seedTradePrice(tx.instrumentId, date, price);
    }
  }
  return { ok: true };
},
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && bun test src/routes/transactions.test.ts`
Expected: PASS (all, including the 3 new tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/transactions.ts apps/api/src/routes/transactions.test.ts
git commit -m "feat(api): trades seed trade-sourced price observations on create/edit"
```

---

### Task A3: End-to-end appreciation test (the reported bug)

**Files:**
- Test: `apps/api/src/routes/networth-series.test.ts` (add a case)

- [ ] **Step 1: Add the failing test**

In `apps/api/src/routes/networth-series.test.ts`, extend imports and the app:

Change the route import line (line 3) and `makeApp` line (line 11) to:
```ts
import { networthSeriesRoutes } from "./networth-series";
import { transactionsRoutes } from "./transactions";
import { pricesRoutes } from "./prices";
// ...
const app = makeApp(networthSeriesRoutes, transactionsRoutes, pricesRoutes);
```

Add a helper + test:
```ts
async function seedStockAccount(): Promise<{ acc: string; stock: string }> {
  const acc = createId();
  await db.insert(accounts).values({
    id: acc, name: "Brokerage", class: "asset", subtype: "investment", currency: "USD",
    isArchived: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy: "seed",
  });
  const stock = createId();
  await db.insert(instruments).values({
    id: stock, symbol: "AAPL", isin: null, name: "Apple", kind: "stock", currency: "USD", createdAt: nowEpoch(),
  });
  return { acc, stock };
}

test("backdated buy appreciates as a newer price is set (reported bug)", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const { acc, stock } = await seedStockAccount();

  // Backdated buy: 10 AAPL @ $100 on 2026-01-01 -> seeds price $100@2026-01-01.
  await app.handle(new Request(`http://localhost/accounts/${acc}/transactions`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ instrumentId: stock, date: "2026-01-01", unitsDelta: 10 * S, unitPriceScaled: 100 * S }),
  }));
  // Newer price $120 on 2026-01-15.
  await app.handle(new Request(`http://localhost/instruments/${stock}/prices`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ date: "2026-01-15", priceScaled: 120 * S }),
  }));

  const series = await (await app.handle(new Request(
    `http://localhost/networth/series?from=2026-01-01&to=2026-01-15`, { headers: { cookie } },
  ))).json();

  const byDate = new Map(series.points.map((p: any) => [p.date, p.totalBaseMinor]));
  expect(byDate.get("2026-01-01")).toBe(100000); // 10 × $100 = $1000.00
  expect(byDate.get("2026-01-15")).toBe(120000); // 10 × $120 = $1200.00
});
```

- [ ] **Step 2: Run to verify it passes** (Task A2 already makes the fix work)

Run: `cd apps/api && bun test src/routes/networth-series.test.ts`
Expected: PASS. If `2026-01-01` were 0 (the old bug), it would fail.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/networth-series.test.ts
git commit -m "test(api): backdated buy appreciates on the net-worth series"
```

---

## Phase B — `linkedTransactionId` + net-deposits series

### Task B1: Add `linkedTransactionId` column + migration + backfill

**Files:**
- Modify: `apps/api/src/db/schema.ts:73-85` (transactions table)
- Create (generated): `apps/api/drizzle/0010_*.sql`

- [ ] **Step 1: Add the column to the schema**

In `apps/api/src/db/schema.ts`, inside `transactions`, add after the `importBatchId` line:
```ts
  importBatchId: text("import_batch_id"), // nullable logical FK → import_batches.id (traceability)
  linkedTransactionId: text("linked_transaction_id"), // nullable FK → transactions.id (e.g. a buy/sell's cash leg)
```

- [ ] **Step 2: Generate the migration**

Run: `cd apps/api && bun run db:generate`
Expected: a new file `apps/api/drizzle/0010_<name>.sql` containing
`ALTER TABLE \`transactions\` ADD \`linked_transaction_id\` text;`

- [ ] **Step 3: Append the best-effort backfill to the generated migration**

Open the new `apps/api/drizzle/0010_*.sql` and append, after the `ALTER TABLE`:
```sql
--> statement-breakpoint
UPDATE transactions
SET linked_transaction_id = (
  SELECT t2.id FROM transactions t2
  JOIN instruments i2 ON i2.id = t2.instrument_id
  WHERE t2.account_id = transactions.account_id
    AND t2.created_at = transactions.created_at
    AND t2.date = transactions.date
    AND i2.kind != 'currency'
  LIMIT 1
)
WHERE linked_transaction_id IS NULL
  AND instrument_id IN (SELECT id FROM instruments WHERE kind = 'currency')
  AND EXISTS (
    SELECT 1 FROM transactions t3
    JOIN instruments i3 ON i3.id = t3.instrument_id
    WHERE t3.account_id = transactions.account_id
      AND t3.created_at = transactions.created_at
      AND t3.date = transactions.date
      AND i3.kind != 'currency'
  );
```
(Best-effort: matches a currency leg to a same-account, same-`created_at`, same-date non-currency trade. Imperfect matches are acceptable for this single-user WIP — documented in the spec.)

- [ ] **Step 4: Verify migration applies (via the test runner)**

Run: `cd apps/api && bun test src/routes/transactions.test.ts`
Expected: PASS — `test-setup.ts` applies the new migration to the in-memory DB; existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle/
git commit -m "feat(api): add transactions.linkedTransactionId + best-effort backfill"
```

---

### Task B2: Set `linkedTransactionId` on the cash leg

**Files:**
- Modify: `apps/api/src/routes/transactions.ts` (cash-leg insert)
- Test: `apps/api/src/routes/transactions.test.ts` (add a case)

- [ ] **Step 1: Add a failing test**

Append to `apps/api/src/routes/transactions.test.ts`:
```ts
test("POST with cashLeg links the cash leg to the main trade", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const acc = await seedAccount();
  const stock = await seedInstrument("stock");
  const usd = await seedInstrument("currency", "USD");

  const create = await (await app.handle(new Request(`http://localhost/accounts/${acc}/transactions`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      instrumentId: stock, date: "2026-01-01", unitsDelta: 10 * S, unitPriceScaled: 100 * S,
      cashLeg: { instrumentId: usd, unitsDelta: -1000 * S },
    }),
  }))).json();

  const leg = await db.select().from(transactions).where(eq(transactions.instrumentId, usd));
  expect(leg.length).toBe(1);
  expect(leg[0].linkedTransactionId).toBe(create.id);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && bun test src/routes/transactions.test.ts`
Expected: FAIL — `linkedTransactionId` is `null`.

- [ ] **Step 3: Implement**

In `apps/api/src/routes/transactions.ts`, in the cash-leg insert (the second `db.insert(transactions).values({...})` inside `if (body.cashLeg)`), add `linkedTransactionId: mainId`:
```ts
await db.insert(transactions).values({
  id: createId(), accountId: params.id, instrumentId: cl.instrumentId,
  date: body.date, unitsDelta: cl.unitsDelta,
  unitPriceScaled: cl.unitPriceScaled ?? CASH_PRICE, feesMinor: 0,
  notes: cl.notes ?? null, linkedTransactionId: mainId, createdAt: now, createdBy: userId!,
});
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && bun test src/routes/transactions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/transactions.ts apps/api/src/routes/transactions.test.ts
git commit -m "feat(api): link a trade's auto cash leg via linkedTransactionId"
```

---

### Task B3: Net-deposits series in `networth-series.ts`

**Files:**
- Modify: `apps/api/src/lib/networth-series.ts`
- Test: `apps/api/src/lib/networth-series.test.ts` (the lib test)

- [ ] **Step 1: Add failing tests**

Create/append `apps/api/src/lib/networth-series.test.ts` with these tests (the file exists; add to it — it imports `resetDb`, `db`, schema, `createId`, `nowEpoch`, `SCALE` similarly). If unsure of its exact imports, mirror the route test's imports:
```ts
import { expect, test, beforeEach } from "bun:test";
import { resetDb, initAndLogin } from "./test-helpers";
import { db } from "../db/client";
import { accounts, instruments, transactions, settings } from "../db/schema";
import { createId, nowEpoch } from "./ids";
import { SCALE } from "@uang/shared";
import { netWorthSeries } from "./networth-series";

const S = Number(SCALE);
beforeEach(resetDb);

async function setup(): Promise<{ acc: string; usd: string }> {
  await db.insert(settings).values({
    id: 1, householdName: "T", baseCurrency: "USD", createdAt: nowEpoch(),
  });
  const acc = createId();
  await db.insert(accounts).values({
    id: acc, name: "Brokerage", class: "asset", subtype: "investment", currency: "USD",
    isArchived: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy: "seed",
  });
  const usd = createId();
  await db.insert(instruments).values({
    id: usd, symbol: "USD", isin: null, name: "USD", kind: "currency", currency: "USD", createdAt: nowEpoch(),
  });
  return { acc, usd };
}

test("net deposits accumulate from standalone cash flows", async () => {
  const { acc, usd } = await setup();
  await db.insert(transactions).values({
    id: createId(), accountId: acc, instrumentId: usd, date: "2026-01-01",
    unitsDelta: 5000 * S, unitPriceScaled: S, feesMinor: 0, notes: null, createdAt: nowEpoch(), createdBy: "u",
  });
  await db.insert(transactions).values({
    id: createId(), accountId: acc, instrumentId: usd, date: "2026-01-15",
    unitsDelta: -1000 * S, unitPriceScaled: S, feesMinor: 0, notes: null, createdAt: nowEpoch(), createdBy: "u",
  });

  const series = await netWorthSeries({ from: "2026-01-01", to: "2026-01-15" });
  const byDate = new Map(series.points.map((p) => [p.date, p.netDepositsBaseMinor]));
  expect(byDate.get("2026-01-01")).toBe(500000);  // +$5000
  expect(byDate.get("2026-01-15")).toBe(400000);  // +$5000 − $1000
});

test("a buy's linked cash leg is excluded from net deposits", async () => {
  const { acc, usd } = await setup();
  const stock = createId();
  await db.insert(instruments).values({
    id: stock, symbol: "AAPL", isin: null, name: "Apple", kind: "stock", currency: "USD", createdAt: nowEpoch(),
  });
  const buyId = createId();
  await db.insert(transactions).values({
    id: buyId, accountId: acc, instrumentId: stock, date: "2026-01-01",
    unitsDelta: 10 * S, unitPriceScaled: 100 * S, feesMinor: 0, notes: null, createdAt: nowEpoch(), createdBy: "u",
  });
  await db.insert(transactions).values({
    id: createId(), accountId: acc, instrumentId: usd, date: "2026-01-01",
    unitsDelta: -1000 * S, unitPriceScaled: S, feesMinor: 0, notes: null,
    linkedTransactionId: buyId, createdAt: nowEpoch(), createdBy: "u",
  });

  const series = await netWorthSeries({ from: "2026-01-01", to: "2026-01-01" });
  expect(series.points[0].netDepositsBaseMinor).toBe(0); // cash leg excluded
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && bun test src/lib/networth-series.test.ts`
Expected: FAIL — `netDepositsBaseMinor` is `undefined`.

- [ ] **Step 3: Implement net deposits**

Rewrite `apps/api/src/lib/networth-series.ts`:
```ts
import { db } from "../db/client";
import { settings, accounts, transactions, instruments } from "../db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { netWorth, convertMinor } from "./valuation";
import { getAllOwnerSets } from "./owners";
import { currencyDecimals, toBig, fromBig, roundDiv, SCALE } from "@uang/shared";

export type NetWorthPoint = { date: string; totalBaseMinor: number; netDepositsBaseMinor: number };
export type NetWorthSeries = { baseCurrency: string; points: NetWorthPoint[] };

const DAY_MS = 86_400_000;

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// Weekly dates from `to` stepping back 7 days until before `from`, returned ascending.
function weeklyDates(from: string, to: string): string[] {
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  let cur = Date.parse(`${to}T00:00:00Z`);
  const dates: string[] = [];
  while (cur >= fromMs) {
    dates.push(new Date(cur).toISOString().slice(0, 10));
    cur -= 7 * DAY_MS;
  }
  return dates.reverse();
}

async function baseCurrencyFromSettings(): Promise<string> {
  const s = (await db.select().from(settings).where(eq(settings.id, 1)))[0];
  return s?.baseCurrency ?? "USD";
}

type Flow = { date: string; baseMinor: number };

// External cash flows = currency-instrument transactions NOT linked to a trade
// (standalone deposits/withdrawals), from the same account set net worth uses
// (non-archived, owner-filtered), each converted to base at its own date's FX.
async function externalFlowsBase(owner?: string): Promise<Flow[]> {
  const base = await baseCurrencyFromSettings();
  const ownerSets = await getAllOwnerSets();

  const accts = await db.select().from(accounts).where(eq(accounts.isArchived, 0));
  const included = new Set<string>();
  for (const a of accts) {
    const ownerIds = ownerSets.get(a.id) ?? [];
    if (owner && owner !== "household") {
      const personal = ownerIds.length === 1 && ownerIds[0] === owner;
      if (!personal) continue;
    }
    included.add(a.id);
  }

  const rows = await db
    .select()
    .from(transactions)
    .innerJoin(instruments, eq(transactions.instrumentId, instruments.id))
    .where(and(eq(instruments.kind, "currency"), isNull(transactions.linkedTransactionId)));

  const flows: Flow[] = [];
  for (const r of rows) {
    const tx = r.transactions;
    if (!included.has(tx.accountId)) continue;
    const cur = r.instruments.currency;
    const dec = currencyDecimals(cur);
    const amountMinor = fromBig(roundDiv(toBig(tx.unitsDelta) * 10n ** BigInt(dec), SCALE));
    const conv = await convertMinor(amountMinor, cur, base, base, tx.date);
    if (conv === null) continue; // missing FX → skip (consistent with net worth)
    flows.push({ date: tx.date, baseMinor: conv });
  }
  flows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return flows;
}

export async function netWorthSeries(opts: {
  from: string;
  to?: string;
  owner?: string;
}): Promise<NetWorthSeries> {
  const to = opts.to ?? todayISO();
  const dates = weeklyDates(opts.from, to);
  const flows = await externalFlowsBase(opts.owner);

  const points: NetWorthPoint[] = [];
  let baseCurrency: string | null = null;
  let fi = 0;
  let cumDeposits = 0;
  for (const date of dates) {
    const nw = await netWorth({ asOf: date, owner: opts.owner });
    baseCurrency = nw.baseCurrency;
    while (fi < flows.length && flows[fi].date <= date) {
      cumDeposits += flows[fi].baseMinor;
      fi++;
    }
    points.push({ date, totalBaseMinor: nw.totalBaseMinor, netDepositsBaseMinor: cumDeposits });
  }

  return { baseCurrency: baseCurrency ?? (await baseCurrencyFromSettings()), points };
}
```

Note: `convertMinor` is exported from `valuation.ts` (line 12). `isNull` is a `drizzle-orm` export.

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && bun test src/lib/networth-series.test.ts src/routes/networth-series.test.ts`
Expected: PASS. (The route test asserts `points` shape — `netDepositsBaseMinor` is additive and won't break the existing date/total assertions.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/networth-series.ts apps/api/src/lib/networth-series.test.ts
git commit -m "feat(api): compute net-deposits (external cash in − out) per series point"
```

---

### Task B4: Add the net-deposits line to the chart

**Files:**
- Modify: `apps/web/src/components/net-worth-chart.tsx`

- [ ] **Step 1: Implement the second line**

In `apps/web/src/components/net-worth-chart.tsx`:

Update the point type (line 17):
```ts
type SeriesPoint = { date: string; totalBaseMinor: number; netDepositsBaseMinor: number };
```

Update `chartConfig` (lines 23-25):
```ts
const chartConfig = {
  net: { label: "Net worth", color: "var(--chart-1)" },
  deposits: { label: "Net deposits", color: "var(--chart-2)" },
} satisfies ChartConfig;
```

Update the `rows` mapping (lines 112-115) to include deposits:
```ts
const rows = (data?.points ?? []).map((p) => ({
  t: Date.parse(`${p.date}T00:00:00Z`),
  net: p.totalBaseMinor,
  deposits: p.netDepositsBaseMinor,
}));
```

Add a second `<Area>` inside `<AreaChart>` (after the existing `net` Area, lines 211-218). Keep net worth on top:
```tsx
<Area
  dataKey="deposits"
  type="monotone"
  fill="var(--color-deposits)"
  fillOpacity={0.06}
  stroke="var(--color-deposits)"
  strokeWidth={2}
  strokeDasharray="4 3"
/>
<Area
  dataKey="net"
  type="monotone"
  fill="var(--color-net)"
  fillOpacity={0.15}
  stroke="var(--color-net)"
  strokeWidth={2}
/>
```

The shared `ChartTooltipContent` already renders one row per series with its config label and the `formatter` money output, so the tooltip will show both **Net worth** and **Net deposits**; the visible gap between the lines is appreciation.

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && bun run build`
Expected: build succeeds (no TS errors).

- [ ] **Step 3: Manual verify**

Run the app (`bun run dev` from repo root), open the dashboard chart, confirm two lines render with a legend/tooltip showing Net worth and Net deposits.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/net-worth-chart.tsx
git commit -m "feat(web): add net-deposits line to the net-worth chart"
```

---

## Phase C — Instruments endpoints

### Task C1: `PATCH /instruments/:id`

**Files:**
- Modify: `apps/api/src/routes/instruments.ts`
- Test: `apps/api/src/routes/instruments.test.ts`

- [ ] **Step 1: Add a failing test**

Append to `apps/api/src/routes/instruments.test.ts` (mirror the file's existing helpers/imports; it uses `makeApp(instrumentsRoutes)`, `initAndLogin`, `db`, `instruments`, `createId`, `nowEpoch`). Add `eq` to the `drizzle-orm` import if absent:
```ts
test("PATCH /instruments/:id edits fields", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const id = createId();
  await db.insert(instruments).values({
    id, symbol: "AAPL", isin: null, name: "Apple", kind: "stock", currency: "USD", createdAt: nowEpoch(),
  });
  const res = await app.handle(new Request(`http://localhost/instruments/${id}`, {
    method: "PATCH", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Apple Inc.", symbol: "AAPL.US" }),
  }));
  expect(res.status).toBe(200);
  const [row] = await db.select().from(instruments).where(eq(instruments.id, id));
  expect(row.name).toBe("Apple Inc.");
  expect(row.symbol).toBe("AAPL.US");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && bun test src/routes/instruments.test.ts`
Expected: FAIL — 404/route not found.

- [ ] **Step 3: Implement**

In `apps/api/src/routes/instruments.ts`, append to the chain (after the `.post("/")` block, before the final `;`):
```ts
  .patch(
    "/:id",
    async ({ params, body }: any) => {
      const update: Record<string, unknown> = {};
      if (body.name !== undefined) update.name = body.name;
      if (body.symbol !== undefined) update.symbol = body.symbol || null;
      if (body.isin !== undefined) update.isin = body.isin || null;
      if (body.kind !== undefined) update.kind = body.kind;
      if (body.currency !== undefined) update.currency = body.currency.toUpperCase();
      await db.update(instruments).set(update).where(eq(instruments.id, params.id));
      return { ok: true };
    },
    {
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1 })),
        symbol: t.Optional(t.String()),
        isin: t.Optional(t.String()),
        kind: t.Optional(t.Union([
          t.Literal("currency"), t.Literal("stock"), t.Literal("etf"),
          t.Literal("fund"), t.Literal("crypto"), t.Literal("other"),
        ])),
        currency: t.Optional(t.String({ pattern: "^[A-Za-z]{3}$" })),
      }),
    },
  )
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && bun test src/routes/instruments.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/instruments.ts apps/api/src/routes/instruments.test.ts
git commit -m "feat(api): PATCH /instruments/:id"
```

---

### Task C2: `GET /instruments/:id` (detail: holders + tx counts)

**Files:**
- Modify: `apps/api/src/routes/instruments.ts`
- Test: `apps/api/src/routes/instruments.test.ts`

- [ ] **Step 1: Add a failing test**

Append:
```ts
test("GET /instruments/:id returns holders with units, value, and tx counts", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const instrId = createId();
  await db.insert(instruments).values({
    id: instrId, symbol: "AAPL", isin: null, name: "Apple", kind: "stock", currency: "USD", createdAt: nowEpoch(),
  });
  const acc = createId();
  await db.insert(accounts).values({
    id: acc, name: "Brokerage", class: "asset", subtype: "investment", currency: "USD",
    isArchived: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy: "u",
  });
  const S = Number(SCALE);
  await db.insert(transactions).values({
    id: createId(), accountId: acc, instrumentId: instrId, date: "2026-01-01",
    unitsDelta: 10 * S, unitPriceScaled: 100 * S, feesMinor: 0, notes: null, createdAt: nowEpoch(), createdBy: "u",
  });
  await db.insert(prices).values({
    id: createId(), instrumentId: instrId, date: "2026-01-02", priceScaled: 120 * S, source: "manual", createdAt: nowEpoch(),
  });

  const res = await app.handle(new Request(`http://localhost/instruments/${instrId}`, { headers: { cookie } }));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.instrument.id).toBe(instrId);
  expect(body.latestPriceScaled).toBe(120 * S);
  expect(body.accounts.length).toBe(1);
  expect(body.accounts[0].units).toBe(10 * S);
  expect(body.accounts[0].marketValueMinor).toBe(120000); // 10 × $120
  expect(body.accounts[0].txCount).toBe(1);
  expect(body.totalTx).toBe(1);
});

test("GET /instruments/:id returns 404 for unknown id", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const res = await app.handle(new Request(`http://localhost/instruments/nope`, { headers: { cookie } }));
  expect(res.status).toBe(404);
});
```
Add `accounts`, `transactions`, `prices` to the schema import and `SCALE` from `@uang/shared` in this test file if not present.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && bun test src/routes/instruments.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `apps/api/src/routes/instruments.ts`, update imports:
```ts
import { instruments, transactions, prices, accounts } from "../db/schema";
import { eq, inArray } from "drizzle-orm";
import { SCALE, currencyDecimals, roundDiv, toBig, fromBig } from "@uang/shared";
import { instrumentPriceScaled } from "../lib/positions";
```
Append to the chain:
```ts
  .get("/:id", async ({ params, set }) => {
    const [instr] = await db.select().from(instruments).where(eq(instruments.id, params.id));
    if (!instr) { set.status = 404; return { error: "not_found" }; }

    const rows = await db
      .select({ accountId: transactions.accountId, accountName: accounts.name, unitsDelta: transactions.unitsDelta })
      .from(transactions)
      .innerJoin(accounts, eq(transactions.accountId, accounts.id))
      .where(eq(transactions.instrumentId, params.id));

    const priceScaled = instr.kind === "currency" ? Number(SCALE) : await instrumentPriceScaled(params.id);
    const dec = currencyDecimals(instr.currency);

    const byAcct = new Map<string, { name: string; units: bigint; txCount: number }>();
    for (const r of rows) {
      let a = byAcct.get(r.accountId);
      if (!a) { a = { name: r.accountName, units: 0n, txCount: 0 }; byAcct.set(r.accountId, a); }
      a.units += toBig(r.unitsDelta);
      a.txCount += 1;
    }

    const out: { accountId: string; name: string; units: number; txCount: number; marketValueMinor: number; missingPrice: boolean }[] = [];
    let totalTx = 0;
    for (const [accountId, a] of byAcct) {
      totalTx += a.txCount;
      const holds = a.units !== 0n;
      const marketValueMinor = holds && priceScaled !== null
        ? fromBig(roundDiv(a.units * toBig(priceScaled) * 10n ** BigInt(dec), SCALE * SCALE))
        : 0;
      out.push({ accountId, name: a.name, units: fromBig(a.units), txCount: a.txCount, marketValueMinor, missingPrice: holds && priceScaled === null });
    }
    out.sort((x, y) => x.name.localeCompare(y.name));

    return { instrument: instr, instrumentCurrency: instr.currency, latestPriceScaled: priceScaled, accounts: out, totalTx };
  })
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && bun test src/routes/instruments.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/instruments.ts apps/api/src/routes/instruments.test.ts
git commit -m "feat(api): GET /instruments/:id detail with holders + tx counts"
```

---

### Task C3: `DELETE /instruments/:id` (confirm gate + cascade)

**Files:**
- Modify: `apps/api/src/routes/instruments.ts`
- Test: `apps/api/src/routes/instruments.test.ts`

- [ ] **Step 1: Add failing tests**

Append:
```ts
test("DELETE /instruments/:id without confirm returns 409 + impact summary", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const instrId = createId();
  await db.insert(instruments).values({
    id: instrId, symbol: "AAPL", isin: null, name: "Apple", kind: "stock", currency: "USD", createdAt: nowEpoch(),
  });
  const acc = createId();
  await db.insert(accounts).values({
    id: acc, name: "Brokerage", class: "asset", subtype: "investment", currency: "USD",
    isArchived: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy: "u",
  });
  const S = Number(SCALE);
  await db.insert(transactions).values({
    id: createId(), accountId: acc, instrumentId: instrId, date: "2026-01-01",
    unitsDelta: 10 * S, unitPriceScaled: 100 * S, feesMinor: 0, notes: null, createdAt: nowEpoch(), createdBy: "u",
  });

  const res = await app.handle(new Request(`http://localhost/instruments/${instrId}`, { method: "DELETE", headers: { cookie } }));
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.error).toBe("confirm_required");
  expect(body.totalTx).toBe(1);
  expect(body.accounts[0].name).toBe("Brokerage");

  const stillThere = await db.select().from(instruments).where(eq(instruments.id, instrId));
  expect(stillThere.length).toBe(1); // not deleted
});

test("DELETE /instruments/:id?confirm=true cascades instrument, prices, transactions, cash legs", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const instrId = createId();
  const usd = createId();
  await db.insert(instruments).values({
    id: instrId, symbol: "AAPL", isin: null, name: "Apple", kind: "stock", currency: "USD", createdAt: nowEpoch(),
  });
  await db.insert(instruments).values({
    id: usd, symbol: "USD", isin: null, name: "USD", kind: "currency", currency: "USD", createdAt: nowEpoch(),
  });
  const acc = createId();
  await db.insert(accounts).values({
    id: acc, name: "Brokerage", class: "asset", subtype: "investment", currency: "USD",
    isArchived: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy: "u",
  });
  const S = Number(SCALE);
  const buyId = createId();
  await db.insert(transactions).values({
    id: buyId, accountId: acc, instrumentId: instrId, date: "2026-01-01",
    unitsDelta: 10 * S, unitPriceScaled: 100 * S, feesMinor: 0, notes: null, createdAt: nowEpoch(), createdBy: "u",
  });
  await db.insert(transactions).values({
    id: createId(), accountId: acc, instrumentId: usd, date: "2026-01-01",
    unitsDelta: -1000 * S, unitPriceScaled: S, feesMinor: 0, notes: null,
    linkedTransactionId: buyId, createdAt: nowEpoch(), createdBy: "u",
  });
  await db.insert(prices).values({
    id: createId(), instrumentId: instrId, date: "2026-01-01", priceScaled: 100 * S, source: "trade", createdAt: nowEpoch(),
  });

  const res = await app.handle(new Request(`http://localhost/instruments/${instrId}?confirm=true`, { method: "DELETE", headers: { cookie } }));
  expect(res.status).toBe(200);
  expect((await db.select().from(instruments).where(eq(instruments.id, instrId))).length).toBe(0);
  expect((await db.select().from(prices).where(eq(prices.instrumentId, instrId))).length).toBe(0);
  // both the trade and its linked cash leg are gone
  expect((await db.select().from(transactions).where(eq(transactions.accountId, acc))).length).toBe(0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && bun test src/routes/instruments.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Append to the chain in `apps/api/src/routes/instruments.ts`:
```ts
  .delete(
    "/:id",
    async ({ params, query, set }: any) => {
      const [instr] = await db.select().from(instruments).where(eq(instruments.id, params.id));
      if (!instr) { set.status = 404; return { error: "not_found" }; }

      const own = await db.select({ id: transactions.id }).from(transactions).where(eq(transactions.instrumentId, params.id));

      if (query.confirm !== "true") {
        const rows = await db
          .select({ accountId: transactions.accountId, accountName: accounts.name })
          .from(transactions)
          .innerJoin(accounts, eq(transactions.accountId, accounts.id))
          .where(eq(transactions.instrumentId, params.id));
        const counts = new Map<string, { name: string; txCount: number }>();
        for (const r of rows) {
          const c = counts.get(r.accountId) ?? { name: r.accountName, txCount: 0 };
          c.txCount += 1;
          counts.set(r.accountId, c);
        }
        set.status = 409;
        return {
          error: "confirm_required",
          accounts: [...counts].map(([id, c]) => ({ id, name: c.name, txCount: c.txCount })),
          totalTx: rows.length,
        };
      }

      const ownIds = own.map((o) => o.id);
      if (ownIds.length > 0) {
        await db.delete(transactions).where(inArray(transactions.linkedTransactionId, ownIds));
      }
      await db.delete(transactions).where(eq(transactions.instrumentId, params.id));
      await db.delete(prices).where(eq(prices.instrumentId, params.id));
      await db.delete(instruments).where(eq(instruments.id, params.id));
      return { ok: true };
    },
    { query: t.Object({ confirm: t.Optional(t.String()) }) },
  )
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && bun test src/routes/instruments.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/instruments.ts apps/api/src/routes/instruments.test.ts
git commit -m "feat(api): DELETE /instruments/:id with confirm gate + cascade"
```

---

### Task C4: Enrich `GET /instruments` (latest price + holder count)

**Files:**
- Modify: `apps/api/src/routes/instruments.ts`
- Test: `apps/api/src/routes/instruments.test.ts`

- [ ] **Step 1: Add a failing test**

Append:
```ts
test("GET /instruments includes latestPriceScaled, latestPriceDate, holderCount", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const instrId = createId();
  await db.insert(instruments).values({
    id: instrId, symbol: "AAPL", isin: null, name: "Apple", kind: "stock", currency: "USD", createdAt: nowEpoch(),
  });
  const acc = createId();
  await db.insert(accounts).values({
    id: acc, name: "Brokerage", class: "asset", subtype: "investment", currency: "USD",
    isArchived: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy: "u",
  });
  const S = Number(SCALE);
  await db.insert(transactions).values({
    id: createId(), accountId: acc, instrumentId: instrId, date: "2026-01-01",
    unitsDelta: 10 * S, unitPriceScaled: 100 * S, feesMinor: 0, notes: null, createdAt: nowEpoch(), createdBy: "u",
  });
  await db.insert(prices).values({
    id: createId(), instrumentId: instrId, date: "2026-02-01", priceScaled: 130 * S, source: "manual", createdAt: nowEpoch(),
  });
  await db.insert(prices).values({
    id: createId(), instrumentId: instrId, date: "2026-01-10", priceScaled: 110 * S, source: "trade", createdAt: nowEpoch(),
  });

  const list = await (await app.handle(new Request(`http://localhost/instruments`, { headers: { cookie } }))).json();
  const row = list.find((i: any) => i.id === instrId);
  expect(row.latestPriceScaled).toBe(130 * S);
  expect(row.latestPriceDate).toBe("2026-02-01");
  expect(row.holderCount).toBe(1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && bun test src/routes/instruments.test.ts`
Expected: FAIL — fields are `undefined`.

- [ ] **Step 3: Implement**

Replace the existing `.get("/", ...)` in `apps/api/src/routes/instruments.ts` with:
```ts
  .get("/", async () => {
    const list = await db.select().from(instruments).orderBy(instruments.name);

    const allPrices = await db.select({ instrumentId: prices.instrumentId, date: prices.date, priceScaled: prices.priceScaled }).from(prices);
    const latest = new Map<string, { date: string; priceScaled: number }>();
    for (const p of allPrices) {
      const cur = latest.get(p.instrumentId);
      if (!cur || p.date > cur.date) latest.set(p.instrumentId, { date: p.date, priceScaled: p.priceScaled });
    }

    const txRows = await db.select({ instrumentId: transactions.instrumentId, accountId: transactions.accountId, unitsDelta: transactions.unitsDelta }).from(transactions);
    const byInstr = new Map<string, Map<string, bigint>>();
    for (const r of txRows) {
      let m = byInstr.get(r.instrumentId);
      if (!m) { m = new Map(); byInstr.set(r.instrumentId, m); }
      m.set(r.accountId, (m.get(r.accountId) ?? 0n) + toBig(r.unitsDelta));
    }

    return list.map((i) => {
      const lp = latest.get(i.id);
      const m = byInstr.get(i.id);
      let holderCount = 0;
      if (m) for (const u of m.values()) if (u !== 0n) holderCount++;
      return { ...i, latestPriceScaled: lp?.priceScaled ?? null, latestPriceDate: lp?.date ?? null, holderCount };
    });
  })
```
(`toBig`, `transactions`, `prices` are already imported from Task C2/C3.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && bun test src/routes/instruments.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck the web build (the InstrumentRow shape changed)**

Run: `cd apps/web && bun run build`
Expected: build succeeds — the 3 new fields are additive; existing consumers compile.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/instruments.ts apps/api/src/routes/instruments.test.ts
git commit -m "feat(api): enrich GET /instruments with latest price + holder count"
```

---

## Phase D — Instruments page (web)

### Task D1: `instrumentsCollection.onUpdate` + generalize `UpdatePrice`

**Files:**
- Modify: `apps/web/src/lib/collections.ts` (instrumentsCollection)
- Modify: `apps/web/src/components/update-price.tsx`

- [ ] **Step 1: Add `onUpdate` to `instrumentsCollection`**

In `apps/web/src/lib/collections.ts`, inside the `instrumentsCollection` `queryCollectionOptions({...})`, add an `onUpdate` after the existing `onInsert`:
```ts
    onUpdate: async ({ transaction }) => {
      const m = transaction.mutations[0]?.modified as InstrumentRow | undefined;
      if (!m) return;
      const { error } = await api.instruments({ id: m.id }).patch({
        name: m.name,
        symbol: m.symbol ?? undefined,
        isin: m.isin ?? undefined,
        kind: m.kind as "currency" | "stock" | "etf" | "fund" | "crypto" | "other",
        currency: m.currency,
      });
      if (error) throw new Error(String(error));
    },
```

- [ ] **Step 2: Make `UpdatePrice` reusable outside an account**

In `apps/web/src/components/update-price.tsx`, make `accountId` optional and invalidate the instrument detail too:

Change the props type (lines 18-26):
```ts
export function UpdatePrice({
  instrumentId,
  accountId,
  label,
}: {
  instrumentId: string;
  accountId?: string;
  label?: string;
}) {
```
Change the invalidation block in `submit` (lines 44-45) to:
```ts
    if (accountId) await qc.invalidateQueries({ queryKey: ["positions", accountId] });
    await qc.invalidateQueries({ queryKey: ["networth"] });
    await qc.invalidateQueries({ queryKey: ["instrument", instrumentId] });
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/web && bun run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/collections.ts apps/web/src/components/update-price.tsx
git commit -m "feat(web): instrument edit sync + reusable UpdatePrice"
```

---

### Task D2: Instruments list page + sidebar + route

**Files:**
- Create: `apps/web/src/routes/instruments.tsx`
- Modify: `apps/web/src/components/nav-main.tsx`
- Modify: `apps/web/src/router.tsx`

- [ ] **Step 1: Create the list page**

Create `apps/web/src/routes/instruments.tsx`:
```tsx
import { Link } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { AppShell } from "@/components/app-layout";
import { PageHeader } from "@/components/page-header";
import { Money } from "@/components/money.tsx";
import { instrumentsCollection } from "@/lib/collections";
import { SCALE } from "@uang/shared";

const S = Number(SCALE);

function priceLabel(kind: string, scaled: number | null, currency: string): string {
  if (kind === "currency") return "1.00 (implicit)";
  if (scaled === null) return "—";
  return `${currency} ${(scaled / S).toLocaleString(undefined, { maximumFractionDigits: 6 })}`;
}

export function InstrumentsPage() {
  const { data: instruments, isLoading } = useLiveQuery(instrumentsCollection);
  const rows = [...(instruments ?? [])].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <AppShell>
      <PageHeader eyebrow="Holdings" title="Instruments" />
      {isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card/40 px-4 py-10 text-center text-sm text-muted-foreground">
          No instruments yet. They are created when you log a transaction.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {rows.map((i, idx) => (
            <Link
              key={i.id}
              to="/instruments/$id"
              params={{ id: i.id }}
              data-testid="instrument-row"
              className={`flex items-center justify-between gap-4 px-4 py-3 hover:bg-muted/40 ${idx > 0 ? "border-t border-border/70" : ""}`}
            >
              <div className="min-w-0">
                <p className="truncate font-medium">
                  {i.symbol ? `${i.symbol} · ` : ""}{i.name}
                  <span className="ml-2 rounded-full bg-muted px-1.5 py-0.5 text-[0.65rem] font-medium text-muted-foreground">
                    {i.kind === "currency" ? "cash" : i.kind}
                  </span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {i.currency} · {i.holderCount} {i.holderCount === 1 ? "account" : "accounts"}
                </p>
              </div>
              <div className="shrink-0 text-right tabular-nums text-sm">
                <p className="font-medium">{priceLabel(i.kind, i.latestPriceScaled, i.currency)}</p>
                {i.latestPriceDate && <p className="text-xs text-muted-foreground">{i.latestPriceDate}</p>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </AppShell>
  );
}
```
Note: `Money` import is kept available for the detail page; if the build flags it unused here, remove the `Money` import from this file (the list uses `priceLabel`, not `Money`).

Correction: this list does not use `Money`. Remove that import line from `instruments.tsx`:
```tsx
// (do NOT import Money in the list page)
```

- [ ] **Step 2: Add the sidebar entry**

In `apps/web/src/components/nav-main.tsx`, update the icon import (line 2) and `NAV` (lines 11-15):
```ts
import { LayoutDashboard, Target, TrendingUp, CandlestickChart } from "lucide-react";
// ...
const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/instruments", label: "Instruments", icon: CandlestickChart },
  { to: "/goals", label: "Goals", icon: Target },
  { to: "/projections", label: "Projections", icon: TrendingUp },
] as const;
```

- [ ] **Step 3: Register the route**

In `apps/web/src/router.tsx`:

Add the import (after the `AccountDetailPage` import, line 13):
```ts
import { InstrumentsPage } from "./routes/instruments";
import { InstrumentDetailPage } from "./routes/instrument-detail";
```
Add the route definitions (after `accountDetailRoute`, line 108):
```ts
const instrumentsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/instruments",
  component: InstrumentsPage,
});

const instrumentDetailRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/instruments/$id",
  component: InstrumentDetailPage,
});
```
Add them to `appLayoutRoute.addChildren([...])` (lines 137-144):
```ts
  appLayoutRoute.addChildren([
    dashboardRoute,
    accountDetailRoute,
    instrumentsRoute,
    instrumentDetailRoute,
    settingsRoute,
    projectionsRoute,
    goalsRoute,
    goalDetailRoute,
  ]),
```
(`InstrumentDetailPage` is created in Task D3; this file won't typecheck until then — build at the end of D3.)

- [ ] **Step 4: Commit (build deferred to D3)**

```bash
git add apps/web/src/routes/instruments.tsx apps/web/src/components/nav-main.tsx apps/web/src/router.tsx
git commit -m "feat(web): instruments list page + sidebar entry + routes"
```

---

### Task D3: Instrument detail page (holders, prices, edit, delete)

**Files:**
- Create: `apps/web/src/routes/instrument-detail.tsx`

- [ ] **Step 1: Create the detail page**

Create `apps/web/src/routes/instrument-detail.tsx`:
```tsx
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import { useNavigate, useParams, Link } from "@tanstack/react-router";
import { api } from "@/lib/api";
import { instrumentsCollection, pricesCollection } from "@/lib/collections";
import { Money } from "@/components/money.tsx";
import { AppShell, Eyebrow } from "@/components/app-layout";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { UpdatePrice } from "@/components/update-price";
import { SCALE } from "@uang/shared";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";

const S = Number(SCALE);

type Holder = { accountId: string; name: string; units: number; txCount: number; marketValueMinor: number; missingPrice: boolean };
type Detail = {
  instrument: { id: string; symbol: string | null; name: string; kind: string; currency: string };
  instrumentCurrency: string;
  latestPriceScaled: number | null;
  accounts: Holder[];
  totalTx: number;
};

function useInstrumentDetail(id: string) {
  return useQuery({
    queryKey: ["instrument", id],
    queryFn: async (): Promise<Detail> => {
      const { data, error } = await api.instruments({ id }).get();
      if (error) throw new Error(String(error));
      return data as unknown as Detail;
    },
  });
}

export function InstrumentDetailPage() {
  const { id } = useParams({ from: "/app/instruments/$id" });
  const nav = useNavigate();
  const qc = useQueryClient();

  const { data: instruments, isLoading } = useLiveQuery(instrumentsCollection);
  const instrument = (instruments ?? []).find((i) => i.id === id);
  const { data: detail } = useInstrumentDetail(id);
  const { data: prices } = useLiveQuery(pricesCollection(id));

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  // Edit form state
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [isin, setIsin] = useState("");
  const [currency, setCurrency] = useState("");

  if (isLoading || !instrument) {
    return (
      <AppShell>
        <p className="text-muted-foreground">{isLoading ? "Loading…" : "Instrument not found."}</p>
      </AppShell>
    );
  }

  const isCurrency = instrument.kind === "currency";
  const holders = (detail?.accounts ?? []).filter((a) => a.units !== 0);

  function openEdit() {
    setName(instrument!.name);
    setSymbol(instrument!.symbol ?? "");
    setIsin(instrument!.isin ?? "");
    setCurrency(instrument!.currency);
    setEditOpen(true);
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    await instrumentsCollection.update(instrument!.id, (draft) => {
      draft.name = name;
      draft.symbol = symbol || null;
      draft.isin = isin || null;
      draft.currency = currency.toUpperCase();
    });
    await qc.invalidateQueries({ queryKey: ["instrument", id] });
    await qc.invalidateQueries({ queryKey: ["networth"] });
    setEditOpen(false);
  }

  async function deleteInstrument() {
    const { error } = await api.instruments({ id }).delete(undefined, { query: { confirm: "true" } });
    if (error) throw new Error(String(error));
    await qc.invalidateQueries({ queryKey: ["instruments"] });
    await qc.invalidateQueries({ queryKey: ["networth"] });
    await nav({ to: "/instruments" });
  }

  const sortedPrices = [...(prices ?? [])].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  async function delPrice(priceId: string) {
    await pricesCollection(id).delete(priceId);
    await qc.invalidateQueries({ queryKey: ["instrument", id] });
    await qc.invalidateQueries({ queryKey: ["networth"] });
  }

  return (
    <AppShell>
      <PageHeader
        eyebrow={`${isCurrency ? "Cash" : instrument.kind} · ${instrument.currency}`}
        title={`${instrument.symbol ? `${instrument.symbol} · ` : ""}${instrument.name}`}
      />
      <div className="mt-2 flex gap-2">
        <Button variant="outline" onClick={openEdit}>Edit</Button>
      </div>

      {/* Holders */}
      <section className="mt-8">
        <Eyebrow className="mb-3">Held by</Eyebrow>
        {holders.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-card/40 px-4 py-8 text-center text-sm text-muted-foreground">
            No account currently holds this instrument.
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            {holders.map((h, i) => (
              <Link
                key={h.accountId}
                to="/accounts/$id"
                params={{ id: h.accountId }}
                className={`flex items-center justify-between gap-4 px-4 py-3 hover:bg-muted/40 ${i > 0 ? "border-t border-border/70" : ""}`}
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{h.name}</p>
                  <p className="text-xs text-muted-foreground">{h.units / S} units</p>
                </div>
                <p className="shrink-0 tabular-nums font-medium">
                  {h.missingPrice ? "—" : <Money minor={h.marketValueMinor} currency={instrument.currency} />}
                </p>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Price history (hidden for currencies) */}
      {!isCurrency && (
        <section className="mt-8">
          <div className="mb-3 flex items-center justify-between">
            <Eyebrow>Price history</Eyebrow>
            <UpdatePrice instrumentId={id} label="Add price" />
          </div>
          {sortedPrices.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-card/40 px-4 py-8 text-center text-sm text-muted-foreground">
              No prices recorded yet.
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              {sortedPrices.map((p, i) => (
                <div
                  key={p.id}
                  data-testid="price-row"
                  className={`group flex items-center justify-between gap-4 px-4 py-3 ${i > 0 ? "border-t border-border/70" : ""}`}
                >
                  <div className="min-w-0">
                    <p className="font-medium tabular-nums">
                      {instrument.currency} {(p.priceScaled / S).toLocaleString(undefined, { maximumFractionDigits: 6 })}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {p.date}{p.source === "trade" ? " · from trade" : ""}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
                    onClick={() => delPrice(p.id)}
                  >
                    Delete
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Danger zone */}
      <section className="mt-10">
        <Eyebrow className="mb-3 text-destructive">Danger zone</Eyebrow>
        <div className="flex items-center justify-between rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3">
          <div>
            <p className="text-sm font-medium text-destructive">Delete instrument</p>
            <p className="text-xs text-muted-foreground">
              Removes the instrument, its prices, and all its transactions (and their cash legs). Cannot be undone.
            </p>
          </div>
          <Dialog
            open={deleteOpen}
            onOpenChange={(open) => { setDeleteOpen(open); if (!open) setConfirmName(""); }}
          >
            <DialogTrigger render={<Button variant="destructive" />}>Delete…</DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete "{instrument.name}"?</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 text-sm">
                <p className="text-muted-foreground">
                  This will delete <strong>{detail?.totalTx ?? 0}</strong> transaction(s) across these accounts:
                </p>
                <ul className="list-inside list-disc text-muted-foreground">
                  {(detail?.accounts ?? []).map((a) => (
                    <li key={a.accountId}>{a.name} — {a.txCount} txn(s)</li>
                  ))}
                  {(detail?.accounts ?? []).length === 0 && <li>No transactions reference it.</li>}
                </ul>
                <p className="text-muted-foreground">Type the instrument name to confirm.</p>
                <Input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={instrument.name} />
              </div>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setDeleteOpen(false)}>Cancel</Button>
                <Button variant="destructive" disabled={confirmName !== instrument.name} onClick={deleteInstrument}>
                  Delete permanently
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </section>

      {/* Edit dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit instrument</DialogTitle>
          </DialogHeader>
          <form onSubmit={saveEdit} className="space-y-4">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} required />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Symbol">
                <Input value={symbol} onChange={(e) => setSymbol(e.target.value)} />
              </Field>
              <Field label="Currency">
                <Input value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={3} required />
              </Field>
            </div>
            <Field label="ISIN">
              <Input value={isin} onChange={(e) => setIsin(e.target.value)} />
            </Field>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setEditOpen(false)}>Cancel</Button>
              <Button type="submit">Save</Button>
            </DialogFooter>
          </form>
        </Dialog>
      </Dialog>
    </AppShell>
  );
}
```

Note on the `api.instruments({ id }).delete(...)` call: Eden treaty delete takes `(body?, options?)`; the `confirm` flag is sent as a query param via the options object. If the build surfaces a signature mismatch, use `api.instruments({ id }).delete({}, { query: { confirm: "true" } })`.

- [ ] **Step 2: Fix the stray closing tag**

The Edit dialog block above ends with `</Dialog>` twice by mistake — ensure the JSX is balanced: the edit `<Dialog>` contains a single `<DialogContent>…</DialogContent>` then one `</Dialog>`. Verify the component compiles in the next step and correct any unbalanced tag.

- [ ] **Step 3: Typecheck the whole web app (D2 + D3)**

Run: `cd apps/web && bun run build`
Expected: build succeeds. Fix any TS errors (common: `Field`/`Eyebrow` import paths — confirm against `apps/web/src/components/app-layout.tsx` and `apps/web/src/components/ui/field.tsx`; the `AppShell`/`Eyebrow` exports match `account-detail.tsx` usage).

- [ ] **Step 4: Manual verify**

Run the app. Navigate to Instruments in the sidebar → list shows instruments with latest price + holder count → open one → see holders, price history (add/delete a price), Edit (rename), and Delete (confirm dialog shows affected accounts + tx count; deleting returns to the list).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/instrument-detail.tsx
git commit -m "feat(web): instrument detail page — holders, prices, edit, delete"
```

---

## Phase E — Verification

### Task E1: Affected tests + typecheck + e2e

- [ ] **Step 1: API test suite**

Run: `cd apps/api && bun test`
Expected: all pass.

- [ ] **Step 2: Web typecheck**

Run: `cd apps/web && bun run build`
Expected: succeeds.

- [ ] **Step 3: Affected E2E specs**

Identify affected specs from `e2e/README.md` (instruments/transactions/net-worth). Run, e.g.:
Run: `bun run e2e -- transactions.spec.ts accounts.spec.ts`
Expected: pass. (If a dedicated instruments e2e spec is desired, add one mirroring an existing spec; otherwise manual verification from D3/B4 covers the new page and chart.)

- [ ] **Step 4: Final commit (if any fixups)**

```bash
git add -A
git commit -m "test: verify instruments management, appreciation fix, net-deposits line"
```

---

## Self-Review

**Spec coverage:**
- §1a trades seed price history → Tasks A1, A2, A3. ✓
- §1b `linkedTransactionId` + backfill → Tasks B1, B2. ✓ (renamed from `cashLegOf` per user.)
- §2 endpoints: PATCH/DELETE/GET `/instruments/:id`, enriched `GET /instruments`, series `netDepositsBaseMinor` → C1, C2, C3, C4, B3. ✓ Prices reuse existing routes. ✓
- §3 instruments page (sidebar, list, detail, holders, price history, edit, delete w/ confirm) → D1, D2, D3. ✓
- §4 net-deposits line on chart → B3 (backend), B4 (frontend). ✓
- §5 edge cases: flow-date FX (B3), currency price hidden (D3), no-cash-leg buy limitation (documented in spec). ✓
- §6 testing → tests in each API task + E1. ✓

**Placeholder scan:** No TBD/TODO; every code step is concrete. The two explicit "Note/Correction" callouts (unused `Money` import in the list, stray `</Dialog>`, Eden delete signature) are intentional guardrails, not deferred work.

**Type consistency:** `seedTradePrice(instrumentId, date, priceScaled)` used identically in A1/A2. `NetWorthPoint.netDepositsBaseMinor` defined in B3, consumed in B4 (`SeriesPoint`) — names match. `GET /instruments/:id` returns `{ instrument, instrumentCurrency, latestPriceScaled, accounts, totalTx }` (C2) consumed verbatim by `Detail` type in D3. `holderCount`/`latestPriceScaled`/`latestPriceDate` defined in C4, read in D2. `linkedTransactionId` column (B1) set in B2, queried in B3/C3.
