# Net Contributions / Appreciation Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the net-worth chart's contribution line include invested principal (not just cash deposits), so `Appreciation = NetWorth − Contributions` reflects only true market + FX gains.

**Architecture:** Rework the single helper `externalFlowsBase()` in `apps/api/src/lib/networth-series.ts` into `contributionFlowsBase()`, which treats *any transaction not part of an internal transfer pair* as an external contribution — valuing currency rows at their cash amount and security rows at `unitsDelta × unitPriceScaled`. The frontend only changes the display label. The API response field name `netDepositsBaseMinor` is kept.

**Tech Stack:** Bun, Elysia, Drizzle (libsql/SQLite), `@uang/shared` money helpers (`SCALE`, `toBig`, `fromBig`, `roundDiv`, `currencyDecimals`), `bun:test`. Frontend: React + Recharts wrapper.

**Spec:** `docs/superpowers/specs/2026-06-17-net-contributions-split-design.md`

---

## File Structure

- **Modify** `apps/api/src/lib/networth-series.ts` — replace `externalFlowsBase` with `contributionFlowsBase`; update the call site; trim now-unused imports.
- **Modify** `apps/api/src/lib/networth-series.test.ts` — add four behaviour tests; existing tests stay unchanged and green.
- **Modify** `apps/web/src/components/net-worth-chart.tsx` — rename the `deposits` series label from `"Net deposits"` to `"Net contributions"`.

---

## Task 1: Backend — count invested principal as contributions

**Files:**
- Modify: `apps/api/src/lib/networth-series.ts:1-103`
- Test: `apps/api/src/lib/networth-series.test.ts` (append after line 171)

- [ ] **Step 1: Add the four failing tests**

Append these helpers and tests to the END of `apps/api/src/lib/networth-series.test.ts`:

```ts
// Create a non-currency instrument, return its id.
async function ensureSecurity(symbol: string, currency: string, kind = "stock"): Promise<string> {
  const id = createId();
  await db.insert(instruments).values({
    id, symbol, isin: null, name: symbol, kind, currency, createdAt: nowEpoch(),
  });
  return id;
}

// Create a brokerage (investment) account, return its id.
async function seedBrokerage(currency = "USD"): Promise<string> {
  const id = createId();
  await db.insert(accounts).values({
    id, name: "Brokerage", class: "asset", subtype: "investment", currency,
    isArchived: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy: "seed",
  });
  return id;
}

test("a standalone security buy counts as a contribution at cost basis", async () => {
  await seedSettings("USD");
  const acc = await seedBrokerage();
  const stock = await ensureSecurity("AAPL", "USD");
  await db.insert(transactions).values({
    id: createId(), accountId: acc, instrumentId: stock, date: "2026-01-01",
    unitsDelta: 10 * S, unitPriceScaled: 100 * S, feesMinor: 0, notes: null,
    createdAt: nowEpoch(), createdBy: "u",
  });

  const series = await netWorthSeries({ from: "2026-01-01", to: "2026-01-01" });
  expect(series.points[0].netDepositsBaseMinor).toBe(100000); // 10 × $100 = $1000
});

test("a buy with a cash leg is counted once via the funding deposit", async () => {
  await seedSettings("USD");
  const acc = await seedBrokerage();
  const usd = await ensureCurrency("USD");
  const stock = await ensureSecurity("AAPL", "USD");
  // Standalone cash deposit of $5000.
  await db.insert(transactions).values({
    id: createId(), accountId: acc, instrumentId: usd, date: "2026-01-01",
    unitsDelta: 5000 * S, unitPriceScaled: S, feesMinor: 0, notes: null,
    createdAt: nowEpoch(), createdBy: "u",
  });
  // Buy 10 @ $100 with a linked cash leg of −$1000.
  const buyId = createId();
  await db.insert(transactions).values({
    id: buyId, accountId: acc, instrumentId: stock, date: "2026-01-02",
    unitsDelta: 10 * S, unitPriceScaled: 100 * S, feesMinor: 0, notes: null,
    createdAt: nowEpoch(), createdBy: "u",
  });
  await db.insert(transactions).values({
    id: createId(), accountId: acc, instrumentId: usd, date: "2026-01-02",
    unitsDelta: -1000 * S, unitPriceScaled: S, feesMinor: 0, notes: null,
    linkedTransactionId: buyId, createdAt: nowEpoch(), createdBy: "u",
  });

  const series = await netWorthSeries({ from: "2026-01-01", to: "2026-01-02" });
  // Only the $5000 deposit counts: the buy row (has a cash leg) and the cash
  // leg (linked) are both excluded → no double-count.
  expect(series.points.at(-1)!.netDepositsBaseMinor).toBe(500000);
});

test("a standalone sell reduces contributions by proceeds at sale price", async () => {
  await seedSettings("USD");
  const acc = await seedBrokerage();
  const stock = await ensureSecurity("AAPL", "USD");
  await db.insert(transactions).values({
    id: createId(), accountId: acc, instrumentId: stock, date: "2026-01-01",
    unitsDelta: 10 * S, unitPriceScaled: 100 * S, feesMinor: 0, notes: null,
    createdAt: nowEpoch(), createdBy: "u",
  });
  await db.insert(transactions).values({
    id: createId(), accountId: acc, instrumentId: stock, date: "2026-01-15",
    unitsDelta: -4 * S, unitPriceScaled: 150 * S, feesMinor: 0, notes: null,
    createdAt: nowEpoch(), createdBy: "u",
  });

  const series = await netWorthSeries({ from: "2026-01-01", to: "2026-01-15" });
  const byDate = new Map(series.points.map((p) => [p.date, p.netDepositsBaseMinor]));
  expect(byDate.get("2026-01-01")).toBe(100000);          // +$1000 cost
  expect(byDate.get("2026-01-15")).toBe(100000 - 60000);  // −$600 proceeds (4 × $150)
});

test("contributions combine standalone cash and security buys", async () => {
  await seedSettings("USD");
  const acc = await seedBrokerage();
  const usd = await ensureCurrency("USD");
  const stock = await ensureSecurity("AAPL", "USD");
  await db.insert(transactions).values({
    id: createId(), accountId: acc, instrumentId: usd, date: "2026-01-01",
    unitsDelta: 2000 * S, unitPriceScaled: S, feesMinor: 0, notes: null,
    createdAt: nowEpoch(), createdBy: "u",
  });
  await db.insert(transactions).values({
    id: createId(), accountId: acc, instrumentId: stock, date: "2026-01-01",
    unitsDelta: 5 * S, unitPriceScaled: 100 * S, feesMinor: 0, notes: null,
    createdAt: nowEpoch(), createdBy: "u",
  });

  const series = await netWorthSeries({ from: "2026-01-01", to: "2026-01-01" });
  expect(series.points[0].netDepositsBaseMinor).toBe(250000); // $2000 + $500
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `cd apps/api && bun test src/lib/networth-series.test.ts`
Expected: the four new tests FAIL (e.g. `expect(100000)` receives `0`, because security rows aren't counted yet). The existing five tests PASS.

- [ ] **Step 3: Rework the flow helper**

In `apps/api/src/lib/networth-series.ts`, replace the entire `externalFlowsBase` function (lines 37-74) with:

```ts
// External contributions = every transaction that is NOT part of an internal
// transfer pair, from the same account set net worth uses (non-archived,
// owner-filtered), each valued in base currency at its own date's FX:
//   - currency rows  → the cash amount       (deposit +, withdrawal −)
//   - security rows  → cost/proceeds         (buy +, sell −) = unitsDelta × unitPriceScaled
// A transaction is internal (excluded) when it is itself a cash leg
// (linkedTransactionId set) or a security row that a cash leg points at.
async function contributionFlowsBase(owner?: string): Promise<Flow[]> {
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
    .innerJoin(instruments, eq(transactions.instrumentId, instruments.id));

  // Security rows that a cash leg points at are the internal side of a trade.
  const linkedToIds = new Set<string>();
  for (const r of rows) {
    const linked = r.transactions.linkedTransactionId;
    if (linked !== null) linkedToIds.add(linked);
  }

  const flows: Flow[] = [];
  for (const r of rows) {
    const tx = r.transactions;
    if (!included.has(tx.accountId)) continue;
    if (tx.linkedTransactionId !== null) continue; // a cash leg
    if (linkedToIds.has(tx.id)) continue; // a security row that has a cash leg

    const cur = r.instruments.currency;
    const dec = currencyDecimals(cur);

    let amountMinor: number;
    if (r.instruments.kind === "currency") {
      amountMinor = fromBig(roundDiv(toBig(tx.unitsDelta) * 10n ** BigInt(dec), SCALE));
    } else {
      if (tx.unitPriceScaled === null) continue; // unvaluable holding → skip
      amountMinor = fromBig(
        roundDiv(toBig(tx.unitsDelta) * toBig(tx.unitPriceScaled) * 10n ** BigInt(dec), SCALE * SCALE),
      );
    }

    const conv = await convertMinor(amountMinor, cur, base, base, tx.date);
    if (conv === null) continue; // missing FX → skip (consistent with net worth)
    flows.push({ date: tx.date, baseMinor: conv });
  }
  flows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return flows;
}
```

- [ ] **Step 4: Update the call site**

In `apps/api/src/lib/networth-series.ts`, change line 83 from:

```ts
  const flows = await externalFlowsBase(opts.owner);
```

to:

```ts
  const flows = await contributionFlowsBase(opts.owner);
```

- [ ] **Step 5: Trim now-unused imports**

The new helper no longer uses `and` or `isNull`. Change line 3 from:

```ts
import { and, eq, isNull } from "drizzle-orm";
```

to:

```ts
import { eq } from "drizzle-orm";
```

- [ ] **Step 6: Run all networth-series tests**

Run: `cd apps/api && bun test src/lib/networth-series.test.ts`
Expected: all nine tests PASS (five existing + four new). In particular the existing `"a buy's linked cash leg is excluded from net deposits"` still yields `0` (buy has a cash leg → excluded; no standalone deposit funds it).

- [ ] **Step 7: Run the full API test suite**

Run: `cd apps/api && bun test`
Expected: no NEW failures. (Per project memory there are ~8 pre-existing failures from migration 0016 `instruments_symbol_uq`, unrelated to this change — confirm the count/names match and that none are in `networth-series.test.ts`.)

- [ ] **Step 8: Typecheck via the web build (tsgo strict)**

Run: `cd apps/web && bun run build`
Expected: build succeeds with no type errors (this is the project's strict typecheck path; `bun test` alone does not strict-typecheck).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/lib/networth-series.ts apps/api/src/lib/networth-series.test.ts
git commit -m "feat(networth): count invested principal as contributions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Frontend — rename the contribution series label

**Files:**
- Modify: `apps/web/src/components/net-worth-chart.tsx:25`

- [ ] **Step 1: Rename the label**

In `apps/web/src/components/net-worth-chart.tsx`, change line 25 from:

```ts
  deposits: { label: "Net deposits", color: "var(--chart-2)" },
```

to:

```ts
  deposits: { label: "Net contributions", color: "var(--chart-2)" },
```

(The tooltip row name and legend both read this `chartConfig` label, so this single edit covers both. The `deposits` dataKey, the `netDepositsBaseMinor` field mapping at line 116, and the `appreciation = net − deposits` math are intentionally unchanged.)

- [ ] **Step 2: Typecheck / build the web app**

Run: `cd apps/web && bun run build`
Expected: build succeeds with no type errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/net-worth-chart.tsx
git commit -m "feat(web): label net-worth contribution line 'Net contributions'

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Manual verification against live data

**Files:** none (verification only).

- [ ] **Step 1: Start the app and open the dashboard**

Run the API (`:3000`) and web (`:5173`) dev servers, open the dashboard net-worth chart, select the 1Y range, Household owner.

- [ ] **Step 2: Confirm the corrected behaviour**

Expected with the current DB:
- The gold line is now labeled **"Net contributions"**.
- The pre-2026 baseline is no longer ~$0 — it reflects the 2021–2025 Amundi cost basis (~112k SGD of principal) instead of phantom appreciation.
- Hovering an October 2025 point shows Net contributions ≈ the fund principal (not $0) and a much smaller Appreciation than the previous $112,053.74.
- The 2026-06-15 step is still present (data, not model) but now the gold contributions line steps up *with* the green net-worth line, so Appreciation stays roughly flat across that step rather than spiking.

- [ ] **Step 3: Run affected E2E (only if a spec covers the net-worth chart)**

Check `e2e/README.md`'s spec↔feature map for a net-worth/dashboard chart spec. If one exists, run only it, e.g.:

Run: `bun run e2e -- <matching-spec>.spec.ts`
Expected: PASS. If no spec covers this chart, skip (no E2E change in scope).

---

## Self-Review Notes

- **Spec coverage:** core flow rework (Task 1, Steps 3-5) ✓; currency + security valuation incl. `unitPriceScaled == null` skip (Step 3) ✓; no-double-count via `linkedToIds` (Step 3, Task 1 Step 1 test b) ✓; sells-by-proceeds (test c) ✓; mixed (test d) ✓; label rename (Task 2) ✓; field name kept (call site unchanged, only function renamed) ✓; out-of-scope items untouched ✓.
- **Placeholder scan:** none — every code/command step is concrete.
- **Type consistency:** `contributionFlowsBase` returns `Flow[]` (existing type, unchanged); `netWorthSeries` call site updated to the new name; `Flow`, `SCALE`, `toBig`, `fromBig`, `roundDiv`, `currencyDecimals` all already imported. `SCALE * SCALE` is `bigint * bigint` (SCALE is `100_000_000n`), valid for `roundDiv(num: bigint, den: bigint)`.
