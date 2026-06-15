# Liability Loan Projections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Model every liability as a loan that amortizes its outstanding balance to zero over a remaining term at a given interest rate, replacing the asset-style projection form for liabilities.

**Architecture:** Add one nullable column (`loanTermMonths`) to `accounts`. Liability projection branches into a new monthly-amortization function in `packages/shared` (interest rate reuses the existing `growthRateBps` field; outstanding balance is the account's existing derived value). The web form shows a dedicated Loan editor (rate + term as years/months) with a read-only derived monthly payment; the create flow drops the category picker for liabilities.

**Tech Stack:** Bun, Elysia, Drizzle (libsql/SQLite), drizzle-kit, React, TanStack DB/Query, Eden treaty, `bun test`.

**Spec:** `docs/superpowers/specs/2026-06-15-liability-loan-projections-design.md`

**Key facts established during research:**
- An account's balance is **derived from positions** (`accountValueMinor`), not stored. The loan form therefore **reads** the outstanding balance (`account.balanceMinor` / `account.baseMinor`); it does not edit it. Editable loan inputs are only interest rate and term.
- `ProjectionAccount` (in `packages/shared/src/projection.ts`) has no `class`. We add an explicit `isLiability` flag plus `loanTermMonths` so the shared math can branch without guessing from balance sign.
- `AccountRow` (web) = `RowOf<typeof api.accounts.get>`, derived from the API's `AccountValuation`. Once `valuation.ts` returns `loanTermMonths`, `AccountRow` includes it automatically — but object **literals** of `AccountRow` (e.g. in `account-form.tsx`) must add the field.
- Money math uses BigInt helpers `toBig`, `fromBig`, `roundDiv` from `packages/shared/src/money.ts`. `BPS = 10_000n`.

---

## File Structure

**Modify:**
- `packages/shared/src/projection.ts` — add `isLiability` + `loanTermMonths` to `ProjectionAccount`; add `loanMonthlyPaymentMinor()` + `amortizeLoanSeries()`; branch in `projectAccountSeries()`.
- `packages/shared/src/projection.test.ts` — amortization unit tests.
- `apps/api/src/db/schema.ts` — add `loanTermMonths` column.
- `apps/api/drizzle/0012_*.sql` — generated migration (via `db:generate`).
- `apps/api/src/routes/accounts.ts` — accept `loanTermMonths` in POST + PATCH (body schema + insert/update).
- `apps/api/src/lib/valuation.ts` — add `loanTermMonths` to `AccountValuation` type + mapping.
- `apps/api/src/routes/accounts.test.ts` — route test for persisting `loanTermMonths`.
- `apps/web/src/lib/collections.ts` — send `loanTermMonths` in `onInsert` / `onUpdate`.
- `apps/web/src/components/account-form.tsx` — default `loanTermMonths: null`; drop category picker for liabilities (force `subtype: "loan"`).
- `apps/web/src/components/account-projection-form.tsx` — dedicated Loan form for liabilities.
- `apps/web/src/components/projection-chart.tsx` — map `isLiability` + `loanTermMonths` into `ProjectionAccount`.

---

## Task 1: Shared amortization math

**Files:**
- Modify: `packages/shared/src/projection.ts`
- Test: `packages/shared/src/projection.test.ts`

- [ ] **Step 1: Write failing tests for the payment helper and amortized series**

Add to `packages/shared/src/projection.test.ts` (it already imports from `./projection`; add the new symbols to that import and append these tests):

```ts
import {
  loanMonthlyPaymentMinor,
  projectAccountSeries,
  projectNetWorth,
  type ProjectionAccount,
} from "./projection";

// Minimal liability/loan account factory. baseMinor is negative (debt).
const loan = (over: Partial<ProjectionAccount>): ProjectionAccount => ({
  baseMinor: 0,
  growthRateBps: 0,
  ownerBirthYears: [],
  isLiability: true,
  loanTermMonths: null,
  accessibleFromAge: 0,
  earlyWithdrawal: "none",
  earlyHaircutBps: 0,
  illiquid: false,
  liquidationAge: null,
  spendType: "none",
  spendAmountMinor: null,
  spendRateBps: null,
  spendStartKind: "age",
  spendStartAge: null,
  spendStartTargetMinor: null,
  contributionMinor: 0,
  contributionUntilAge: null,
  compoundInterval: "annually",
  ...over,
});

test("loanMonthlyPaymentMinor: 20,000 @ 5% over 48 months ≈ 460.59", () => {
  // 2_000_000 minor = $20,000.00 ; 500 bps = 5%/yr ; 48 months
  expect(loanMonthlyPaymentMinor(2_000_000, 500, 48)).toBe(46_059);
});

test("loanMonthlyPaymentMinor: 0% is straight-line", () => {
  expect(loanMonthlyPaymentMinor(1_200_000, 0, 12)).toBe(100_000);
});

test("loanMonthlyPaymentMinor: no term => 0", () => {
  expect(loanMonthlyPaymentMinor(1_200_000, 500, 0)).toBe(0);
});

test("amortize 0% loan pays down to exactly 0 within the term", () => {
  // -1200.00, 0%, 12 months: $100/mo, gone after year 1.
  const a = loan({ baseMinor: -120_000, growthRateBps: 0, loanTermMonths: 12 });
  expect(projectAccountSeries(a, 2, 2030, null)).toEqual([-120_000, 0, 0]);
});

test("amortize 0% loan over multiple years", () => {
  // -2400.00, 0%, 24 months: $100/mo => -1200 after y1, 0 after y2.
  const a = loan({ baseMinor: -240_000, growthRateBps: 0, loanTermMonths: 24 });
  expect(projectAccountSeries(a, 3, 2030, null)).toEqual([-240_000, -120_000, 0, 0]);
});

test("amortized loan with interest ends exactly at 0 after the term", () => {
  const a = loan({ baseMinor: -2_000_000, growthRateBps: 500, loanTermMonths: 48 });
  const series = projectAccountSeries(a, 5, 2030, null);
  expect(series[0]).toBe(-2_000_000);
  expect(series[4]).toBe(0); // paid off after 48 months (year 4)
  expect(series[5]).toBe(0); // stays at 0 afterward
  // Debt strictly shrinks toward 0 each year while amortizing.
  expect(series[1]).toBeGreaterThan(series[0]);
  expect(series[2]).toBeGreaterThan(series[1]);
  expect(series[3]).toBeGreaterThan(series[2]);
});

test("liability with no term is held flat (no growth, no paydown)", () => {
  const a = loan({ baseMinor: -50_000, growthRateBps: 500, loanTermMonths: null });
  expect(projectAccountSeries(a, 3, 2030, null)).toEqual([-50_000, -50_000, -50_000, -50_000]);
});

test("net worth rollup: asset grows, loan amortizes away", () => {
  const asset = loan({
    isLiability: false,
    baseMinor: 1_000_000,
    growthRateBps: 0,
    loanTermMonths: null,
  });
  const debt = loan({ baseMinor: -120_000, growthRateBps: 0, loanTermMonths: 12 });
  const pts = projectNetWorth({ accounts: [asset, debt], fromYear: 2030, toYear: 2031 });
  expect(pts[0].totalBaseMinor).toBe(880_000); // 1,000,000 - 120,000
  expect(pts[1].totalBaseMinor).toBe(1_000_000); // loan gone
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/shared && bun test projection.test.ts`
Expected: FAIL — `loanMonthlyPaymentMinor` is not exported and `ProjectionAccount` has no `isLiability` / `loanTermMonths`.

- [ ] **Step 3: Extend the `ProjectionAccount` type**

In `packages/shared/src/projection.ts`, change the `ProjectionAccount` type (currently lines 99-105) to add the two fields:

```ts
export type ProjectionAccount = AccessibilityConfig &
  WithdrawalConfig &
  AccumulationConfig & {
    baseMinor: number;      // current base-currency balance (signed; negative for debt)
    growthRateBps: number;  // assets: growth rate; liabilities: annual loan interest rate
    ownerBirthYears: number[]; // owners' birth years; empty = unknown
    isLiability: boolean;   // true => amortize as a loan instead of accumulate/withdraw
    loanTermMonths: number | null; // remaining loan term; null/0 => no paydown (held flat)
  };
```

- [ ] **Step 4: Add the payment helper and amortization function**

In `packages/shared/src/projection.ts`, add after `projectSeries` (after line 41). The payment formula needs real arithmetic (`Math.pow`), so `P` is computed with `Number` then rounded to integer minor units; the monthly schedule runs in BigInt for exact interest rounding, and the final scheduled month forces the balance to exactly 0 to absorb rounding drift.

```ts
// Fixed monthly payment (minor units, positive) that amortizes an outstanding
// loan `balanceMinor` (magnitude; sign ignored) to zero over `termMonths` at
// `annualRateBps` annual interest. Returns 0 when there is no term.
export function loanMonthlyPaymentMinor(
  balanceMinor: number,
  annualRateBps: number,
  termMonths: number,
): number {
  if (termMonths <= 0) return 0;
  const principal = Math.abs(balanceMinor);
  if (principal === 0) return 0;
  if (annualRateBps === 0) return Math.round(principal / termMonths);
  const r = annualRateBps / 120_000; // monthly rate fraction (bps / 10_000 / 12)
  const payment = (principal * r) / (1 - Math.pow(1 + r, -termMonths));
  return Math.round(payment);
}

// Year-by-year outstanding balance (negative) for a loan, amortized monthly and
// sampled at each year end. Offset 0 is today's balance. With no term (or a
// non-negative balance) the balance is held flat across the whole span.
function amortizeLoanSeries(account: ProjectionAccount, span: number): number[] {
  const start = toBig(account.baseMinor);
  const term = account.loanTermMonths ?? 0;
  // No term, or not actually a debt: hold flat.
  if (term <= 0 || start >= 0n) {
    return Array.from({ length: span + 1 }, () => fromBig(start));
  }
  const payment = toBig(loanMonthlyPaymentMinor(account.baseMinor, account.growthRateBps, term));
  const rateBps = toBig(account.growthRateBps);
  let owed = -start; // positive outstanding magnitude
  const out: number[] = [fromBig(start)];
  let month = 0;
  for (let year = 1; year <= span; year++) {
    for (let m = 0; m < 12; m++) {
      month++;
      if (owed <= 0n || month > term) {
        owed = 0n;
        continue;
      }
      if (month === term) {
        owed = 0n; // final payment clears the remainder exactly
        continue;
      }
      const interest = roundDiv(owed * rateBps, 120_000n); // owed * (rate/12)
      let principalPaid = payment - interest;
      if (principalPaid < 0n) principalPaid = 0n; // guard; formula keeps this positive
      owed = principalPaid >= owed ? 0n : owed - principalPaid;
    }
    out.push(fromBig(-owed));
  }
  return out;
}
```

- [ ] **Step 5: Branch liabilities into the loan path**

In `projectAccountSeries` (currently starts line 121), add the branch as the first lines of the function body, immediately after `assertYears(span);`:

```ts
  assertYears(span);
  if (account.isLiability) return amortizeLoanSeries(account, span);
```

(The rest of `projectAccountSeries` — the asset accumulate/withdraw logic — is unchanged.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd packages/shared && bun test projection.test.ts`
Expected: PASS (all new tests plus existing ones).

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/projection.ts packages/shared/src/projection.test.ts
git commit -m "feat(shared): loan amortization for liability projections

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Add `loanTermMonths` column + migration

**Files:**
- Modify: `apps/api/src/db/schema.ts:16-53`
- Create: `apps/api/drizzle/0012_*.sql` (generated)

- [ ] **Step 1: Add the column to the schema**

In `apps/api/src/db/schema.ts`, inside the `accounts` table, add after the `compoundInterval` column (line 47-49), before `groupId`:

```ts
  compoundInterval: text("compound_interval", { enum: ["monthly", "quarterly", "annually"] })
    .notNull()
    .default("annually"),
  // Liabilities only: remaining loan term in months. null = no term set (held flat).
  loanTermMonths: integer("loan_term_months"),
  groupId: text("group_id"),   // nullable logical FK → groups.id
```

- [ ] **Step 2: Generate the migration**

Run: `cd apps/api && bun run db:generate`
Expected: a new file `apps/api/drizzle/0012_<name>.sql` containing approximately:

```sql
ALTER TABLE `accounts` ADD `loan_term_months` integer;
```

- [ ] **Step 3: Apply the migration locally to verify it runs**

Run: `cd apps/api && bun run db:migrate`
Expected: `migrations applied` with no error.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle/
git commit -m "feat(api): add loan_term_months column to accounts

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: API routes + valuation carry `loanTermMonths`

**Files:**
- Modify: `apps/api/src/routes/accounts.ts` (POST insert + body, PATCH update + body)
- Modify: `apps/api/src/lib/valuation.ts` (type + mapping)

- [ ] **Step 1: Add `loanTermMonths` to the POST insert**

In `apps/api/src/routes/accounts.ts`, in the `db.insert(accounts).values({...})` block, add after `compoundInterval: body.compoundInterval ?? "annually",` (line 66):

```ts
          compoundInterval: body.compoundInterval ?? "annually",
          loanTermMonths: body.loanTermMonths ?? null,
```

- [ ] **Step 2: Add `loanTermMonths` to the POST body schema**

In the POST `body: t.Object({...})` (ends line 105), add after the `compoundInterval` line (line 104):

```ts
        compoundInterval: t.Optional(t.Union([t.Literal("monthly"), t.Literal("quarterly"), t.Literal("annually")])),
        loanTermMonths: t.Optional(t.Union([t.Number(), t.Null()])),
```

- [ ] **Step 3: Add `loanTermMonths` to the PATCH update + body**

In the PATCH `/:id` handler, add after `if (body.compoundInterval !== undefined) update.compoundInterval = body.compoundInterval;`:

```ts
      if (body.compoundInterval !== undefined) update.compoundInterval = body.compoundInterval;
      if (body.loanTermMonths !== undefined) update.loanTermMonths = body.loanTermMonths;
```

And in the PATCH `body: t.Object({...})`, add after its `compoundInterval` line:

```ts
        compoundInterval: t.Optional(t.Union([t.Literal("monthly"), t.Literal("quarterly"), t.Literal("annually")])),
        loanTermMonths: t.Optional(t.Union([t.Number(), t.Null()])),
```

- [ ] **Step 4: Add `loanTermMonths` to `AccountValuation`**

In `apps/api/src/lib/valuation.ts`, in the `AccountValuation` type, add after `compoundInterval` (line 68):

```ts
  compoundInterval: "monthly" | "quarterly" | "annually";
  loanTermMonths: number | null;
```

- [ ] **Step 5: Map `loanTermMonths` in the `netWorth` builder**

In the `out.push({...})` block, add after `compoundInterval: a.compoundInterval,` (line 121):

```ts
      compoundInterval: a.compoundInterval,
      loanTermMonths: a.loanTermMonths ?? null,
```

- [ ] **Step 6: Verify the API still builds/runs**

Run: `cd apps/api && bun test routes/accounts.test.ts`
Expected: PASS (existing tests unaffected).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/accounts.ts apps/api/src/lib/valuation.ts
git commit -m "feat(api): accept and expose loanTermMonths on accounts

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Route test — `loanTermMonths` round-trips

**Files:**
- Modify: `apps/api/src/routes/accounts.test.ts`

- [ ] **Step 1: Write the failing test**

Open `apps/api/src/routes/accounts.test.ts`, read the top of the file to match its existing helpers (app/treaty setup, how other tests create an account and read it back), then add a test mirroring that style. Use the existing helpers rather than the illustrative calls below — adapt names to what the file already uses:

```ts
test("PATCH persists loanTermMonths and netWorth returns it", async () => {
  // Create a liability (use the file's existing create helper / treaty call).
  const id = await createAccount({ name: "Car loan", class: "liability", subtype: "loan" });

  // Set interest rate + term via PATCH.
  await api.accounts({ id }).patch({ growthRateBps: 500, loanTermMonths: 48 });

  const { data } = await api.networth.get();
  const acct = data!.accounts.find((a) => a.id === id)!;
  expect(acct.loanTermMonths).toBe(48);
  expect(acct.growthRateBps).toBe(500);
});
```

- [ ] **Step 2: Run the test to verify it fails (before Task 3) / passes (after Task 3)**

Run: `cd apps/api && bun test routes/accounts.test.ts -t loanTermMonths`
Expected: PASS (Task 3 already added the plumbing). If it fails on `loanTermMonths` being undefined, recheck Task 3 steps 4-5.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/accounts.test.ts
git commit -m "test(api): loanTermMonths round-trips through PATCH and netWorth

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Web data plumbing

**Files:**
- Modify: `apps/web/src/lib/collections.ts` (onInsert + onUpdate)
- Modify: `apps/web/src/components/account-form.tsx` (default field)
- Modify: `apps/web/src/components/projection-chart.tsx` (ProjectionAccount mapping)

- [ ] **Step 1: Send `loanTermMonths` from the collection mutations**

In `apps/web/src/lib/collections.ts`, in `onInsert` `api.accounts.post({...})`, add after `compoundInterval: m.compoundInterval,` (line 77):

```ts
        compoundInterval: m.compoundInterval,
        loanTermMonths: m.loanTermMonths ?? null,
```

In `onUpdate` `api.accounts({ id: m.id }).patch({...})`, add after `compoundInterval: m.compoundInterval,` (line 104):

```ts
        compoundInterval: m.compoundInterval,
        loanTermMonths: m.loanTermMonths ?? null,
```

- [ ] **Step 2: Default the field when creating an account**

In `apps/web/src/components/account-form.tsx`, in the `row: AccountRow = {...}` literal, add after `compoundInterval: "annually",` (line 75):

```ts
      compoundInterval: "annually",
      loanTermMonths: null,
```

- [ ] **Step 3: Map the loan fields into `ProjectionAccount`**

In `apps/web/src/components/projection-chart.tsx`, in the `projAccounts: ProjectionAccount[] = accounts.map((a) => ({...}))` block, add after `compoundInterval: a.compoundInterval,` (line 117):

```ts
      compoundInterval: a.compoundInterval,
      isLiability: a.class === "liability",
      loanTermMonths: a.loanTermMonths,
```

- [ ] **Step 4: Typecheck the web app**

Run: `cd apps/web && bun run build`
Expected: build succeeds (tsgo type-checks). Fix any "missing property `loanTermMonths`" errors by ensuring the field is present everywhere an `AccountRow`/`ProjectionAccount` literal is built.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/collections.ts apps/web/src/components/account-form.tsx apps/web/src/components/projection-chart.tsx
git commit -m "feat(web): thread loanTermMonths through collections and projection

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Loan form UI for liabilities

**Files:**
- Modify: `apps/web/src/components/account-projection-form.tsx`

This replaces the asset form with a dedicated Loan editor when `account.class === "liability"`. The asset branch (the existing JSX) is untouched — it renders only when `!isLiability`.

- [ ] **Step 1: Add a money formatter import and term helpers**

At the top of `apps/web/src/components/account-projection-form.tsx`, add `loanMonthlyPaymentMinor` to the shared import (line 3) and add term conversion helpers near the other converters (after line 24):

```ts
import { currencyDecimals, loanMonthlyPaymentMinor } from "@uang/shared";
```

```ts
// Loan term <-> months. UI edits years + months; storage is total months.
const splitTerm = (months: number | null) => ({
  years: months == null ? "" : String(Math.floor(months / 12)),
  months: months == null ? "" : String(months % 12),
});
const joinTerm = (years: string, months: string): number | null => {
  const y = parseInt(years, 10) || 0;
  const m = parseInt(months, 10) || 0;
  const total = y * 12 + m;
  return total > 0 ? total : null;
};
const fmtMajor = (minor: number, currency: string) =>
  (minor / 10 ** currencyDecimals(currency)).toLocaleString(undefined, {
    minimumFractionDigits: currencyDecimals(currency),
    maximumFractionDigits: currencyDecimals(currency),
  });
```

- [ ] **Step 2: Seed loan fields in form state**

In `seedForm` (line 43), add to the returned object:

```ts
    loanRatePct: toPct(account.growthRateBps),
    loanTermYears: splitTerm(account.loanTermMonths).years,
    loanTermMonths: splitTerm(account.loanTermMonths).months,
```

(`AccountRow.loanTermMonths` exists because `AccountValuation` now exposes it.)

- [ ] **Step 3: Save loan fields for liabilities**

In `save()` (line 81), wrap the existing asset-field writes so liabilities take a separate path. Replace the body of the `accountsCollection.update(account.id, (draft) => {...})` callback with:

```ts
    accountsCollection.update(account.id, (draft) => {
      if (isLiability) {
        // Single loan model: interest rate + remaining term. Balance comes from
        // transactions; withdrawal/accessibility/contribution are not used.
        draft.growthRateBps = fromPct(f.loanRatePct);
        draft.loanTermMonths = joinTerm(f.loanTermYears, f.loanTermMonths);
        draft.spendType = "none";
        draft.contributionMinor = 0;
        return;
      }
      draft.growthRateBps = fromPct(f.growthPct);
      draft.accessibleFromAge = parseInt(f.accessibleFromAge, 10) || 0;
      draft.earlyWithdrawal = f.earlyWithdrawal;
      draft.earlyHaircutBps = fromPct(f.earlyHaircutPct);
      draft.illiquid = f.illiquid ? 1 : 0;
      draft.liquidationAge = f.liquidationAge === "" ? null : parseInt(f.liquidationAge, 10);
      draft.contributionMinor = toMinor(f.contribution, baseCurrency);
      draft.contributionUntilAge =
        f.contributionUntilAge === "" ? null : parseInt(f.contributionUntilAge, 10);
      draft.compoundInterval = f.compoundInterval;
      const spendType: SpendType = f.spendType;
      draft.spendType = spendType;
      draft.spendAmountMinor =
        spendType === "once" || spendType === "monthly"
          ? toMinor(f.spendAmount, baseCurrency)
          : null;
      draft.spendRateBps = spendType === "percent" ? fromPct(f.spendRate) : null;
      draft.spendStartKind = f.spendStartKind;
      draft.spendStartAge =
        spendType !== "none" && f.spendStartKind === "age"
          ? parseInt(f.spendStartAge, 10) || 0
          : null;
      draft.spendStartTargetMinor =
        spendType !== "none" && f.spendStartKind === "target"
          ? toMinor(f.spendStartTarget, baseCurrency)
          : null;
    });
```

- [ ] **Step 4: Render the Loan form for liabilities**

In the returned JSX (line 116), wrap the existing `<div className="flex flex-col gap-4">…</div>` content so liabilities get the Loan form instead. Replace the opening of the outer content with a conditional. Insert this block as the first child of the top-level `<div>` (before the existing `<div className="flex flex-col gap-4">`), and gate the existing block with `{!isLiability && (...)}`:

```tsx
  const termMonths = joinTerm(f.loanTermYears, f.loanTermMonths);
  const paymentMinor = loanMonthlyPaymentMinor(
    account.balanceMinor,
    fromPct(f.loanRatePct),
    termMonths ?? 0,
  );

  return (
    <div>
      {isLiability ? (
        <div className="flex flex-col gap-4">
          <Field label={`Outstanding balance (${account.currency})`}>
            <Input
              type="text"
              value={fmtMajor(Math.abs(account.balanceMinor), account.currency)}
              readOnly
              disabled
            />
          </Field>
          <div className="grid grid-cols-3 gap-4">
            <Field label="Interest rate %/yr">
              <Input
                type="number"
                step="any"
                min="0"
                value={f.loanRatePct}
                onChange={(e) => setF((p) => ({ ...p, loanRatePct: e.target.value }))}
              />
            </Field>
            <Field label="Term (years)">
              <Input
                type="number"
                min="0"
                placeholder="0"
                value={f.loanTermYears}
                onChange={(e) => setF((p) => ({ ...p, loanTermYears: e.target.value }))}
              />
            </Field>
            <Field label="Term (months)">
              <Input
                type="number"
                min="0"
                max="11"
                placeholder="0"
                value={f.loanTermMonths}
                onChange={(e) => setF((p) => ({ ...p, loanTermMonths: e.target.value }))}
              />
            </Field>
          </div>
          <Field label="Monthly payment (derived)">
            <Input
              type="text"
              value={termMonths ? fmtMajor(paymentMinor, account.currency) : "—"}
              readOnly
              disabled
            />
          </Field>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {/* existing asset form JSX stays here unchanged */}
        </div>
      )}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={save}>Save</Button>
      </div>
    </div>
  );
```

Note: move the existing asset-form `<div className="flex flex-col gap-4">…</div>` (currently lines 118-322) to become the `{!isLiability ? (...)}` branch's child, and remove the now-redundant inner `{!isLiability && (...)}` wrapper around the withdrawal block (lines 227-321) since the whole branch is already asset-only.

- [ ] **Step 5: Typecheck**

Run: `cd apps/web && bun run build`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/account-projection-form.tsx
git commit -m "feat(web): dedicated loan editor for liability projections

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Liability create flow uses a single loan type

**Files:**
- Modify: `apps/web/src/components/account-form.tsx`

Decision from spec: liabilities are a single loan type with the account name as the label. Drop the category picker when the class is "liability" and force `subtype: "loan"`.

- [ ] **Step 1: Force `subtype` to "loan" when class flips to liability**

In `apps/web/src/components/account-form.tsx`, the Type `<Select onValueChange>` (line 111) currently does `v && set("class", v)`. Replace with a handler that also resets subtype:

```tsx
                onValueChange={(v: string | null) => {
                  if (!v) return;
                  set("class", v);
                  // Liabilities are a single loan type; assets keep the picker default.
                  set("subtype", v === "liability" ? "loan" : "bank");
                }}
```

- [ ] **Step 2: Hide the Category picker for liabilities**

Wrap the `<Field label="Category" …>` block (lines 124-145) so it only renders for assets:

```tsx
            {f.class !== "liability" && (
              <Field label="Category" hint="The kind of account: bank account, investment portfolio, property, etc.">
                {/* existing Select unchanged */}
              </Field>
            )}
```

(When the Category field is hidden the grid will show a single column; that's acceptable. If layout looks off, change the wrapping `<div className="grid grid-cols-2 gap-4">` to `className={f.class === "liability" ? "" : "grid grid-cols-2 gap-4"}`.)

- [ ] **Step 3: Typecheck**

Run: `cd apps/web && bun run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/account-form.tsx
git commit -m "feat(web): single loan type for liabilities (drop category picker)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Full verification

- [ ] **Step 1: Run shared + API unit tests**

Run: `bun test` (from repo root — runs `@uang/api` + `@uang/shared`).
Expected: all PASS.

- [ ] **Step 2: Typecheck the web app**

Run: `cd apps/web && bun run build`
Expected: build succeeds (per the project rule: web build is the strict typecheck after API changes).

- [ ] **Step 3: Manual smoke (per the run skill, optional but recommended)**

Start the app, create a liability ("Mortgage"), give it an opening negative balance via a transaction, open it on /projections, set interest rate + term (e.g. 5%, 4 years 0 months), and confirm: the derived monthly payment shows (~$460.59 for a $20,000 / 5% / 48-month example), and the projection line for that account trends up toward 0 and flattens at 0 after the term.

- [ ] **Step 4: Affected E2E (end of slice)**

There is no dedicated projections spec; the closest is `networth-graph.spec.ts`. Run it to ensure the projection page/graph still renders:
Run: `bun run e2e -- networth-graph.spec.ts accounts.spec.ts`
Expected: PASS. (Full suite only needed pre-release per project testing workflow.)

---

## Self-Review Notes

- **Spec coverage:** data model (Tasks 2-3, 5), amortization math + edge cases rate-0/term-unset/short-term/rounding (Task 1), single loan type + free-text label (Task 7), UI with years+months + read-only derived payment + read-only balance (Task 6), no migration of existing data (none added). All covered.
- **Type consistency:** new field is `loanTermMonths` everywhere (schema column `loan_term_months`); `ProjectionAccount` gains `isLiability` + `loanTermMonths`; helper is `loanMonthlyPaymentMinor` in every reference.
- **No placeholders:** every code step shows complete code; the one "use the file's existing helper" note (Task 4) is because the test file's harness must be matched, not invented — read it first.
