# Per-account Withdrawals on /projections — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each account model decumulation (withdrawals) on `/projections`, with full goals-parity spend types, a per-account start trigger (owner age or the account's own target balance), saved to the DB; and move the per-account projection assumptions card from `/accounts/:id` onto `/projections` as one coherent card per account.

**Architecture:** Add six `spend*` columns to `accounts`. Extend the pure projection math in `packages/shared` with a withdrawal-aware per-account simulation, TDD'd. Surface the fields through the accounts API and the `/networth` payload (Eden infers the web types). Build the consolidated per-account card and mount a list of them on `/projections`; remove the card from the account detail page. Wire the new fields into the chart so the curve bends down.

**Tech Stack:** Bun, Elysia, Drizzle (libsql/SQLite), `@uang/shared` (bigint minor-unit math), React, TanStack Router/Query/DB, Eden treaty, recharts.

**Spec:** `docs/superpowers/specs/2026-06-15-projection-account-withdrawals-design.md`

**Conventions:**
- No `as any` (project rule). Assert to specific unions where needed.
- Money is integer minor units; math uses `toBig`/`fromBig`/`roundDiv` and `BPS = 10_000n`.
- Strict typecheck = `cd apps/web && bun run build` (tsgo). `bun test` runs unit tests but does NOT strict-typecheck.
- Withdrawal amounts are stored in **base currency** minor units.

---

## Task 1: Withdrawal math in `packages/shared`

**Files:**
- Modify: `packages/shared/src/projection.ts`
- Test: `packages/shared/src/projection.test.ts`

- [ ] **Step 1: Add the `WithdrawalConfig` type and extend `ProjectionAccount`**

In `packages/shared/src/projection.ts`, replace the existing `ProjectionAccount` type (currently lines ~73-77) with:

```ts
export type SpendType = "none" | "once" | "monthly" | "percent";
export type SpendStartKind = "age" | "target";

export type WithdrawalConfig = {
  spendType: SpendType;
  spendAmountMinor: number | null;   // base minor: 'once' lump / 'monthly' per-month amount
  spendRateBps: number | null;       // 'percent' annual % of balance
  spendStartKind: SpendStartKind;
  spendStartAge: number | null;      // start when youngest owner reaches this age
  spendStartTargetMinor: number | null; // start when this account's balance reaches this (base minor)
};

export type ProjectionAccount = AccessibilityConfig & WithdrawalConfig & {
  baseMinor: number;      // current base-currency balance (signed)
  growthRateBps: number;
  ownerBirthYears: number[]; // owners' birth years; empty = unknown
};
```

- [ ] **Step 2: Add `projectAccountSeries` and rewrite `projectNetWorth`**

In the same file, add `projectAccountSeries` immediately above `projectNetWorth`, and rewrite `projectNetWorth` to use it. Replace the whole existing `projectNetWorth` function (currently lines ~85-114) with:

```ts
// Year-by-year balance for one account, modelling growth then withdrawal.
// Offset 0 is today's balance, untouched. Each later year: grow at growthRateBps,
// then (if the spend trigger has fired and the balance is positive) withdraw.
// Withdrawals never push a balance below 0; naturally-negative balances (debt)
// keep compounding and are never floored.
export function projectAccountSeries(
  account: ProjectionAccount,
  span: number,
  fromYear: number,
  youngestBirthYear: number | null,
): number[] {
  assertYears(span);
  const factor = BPS + toBig(account.growthRateBps);
  let b = toBig(account.baseMinor);
  const out: number[] = [fromBig(b)];
  let started = false;
  let finishedOnce = false;
  for (let offset = 1; offset <= span; offset++) {
    const year = fromYear + offset;
    b = roundDiv(b * factor, BPS); // grow

    if (account.spendType !== "none" && !started) {
      if (account.spendStartKind === "age") {
        if (
          youngestBirthYear !== null &&
          account.spendStartAge !== null &&
          year - youngestBirthYear >= account.spendStartAge
        ) {
          started = true;
        }
      } else if (
        account.spendStartTargetMinor !== null &&
        b >= toBig(account.spendStartTargetMinor)
      ) {
        started = true;
      }
    }

    if (started && b > 0n) {
      if (account.spendType === "once") {
        if (!finishedOnce) {
          const amt = toBig(account.spendAmountMinor ?? 0);
          b = amt > b ? 0n : b - amt;
          finishedOnce = true;
        }
      } else if (account.spendType === "monthly") {
        const amt = toBig(account.spendAmountMinor ?? 0) * 12n;
        b = amt > b ? 0n : b - amt;
      } else if (account.spendType === "percent") {
        const wd = roundDiv(b * toBig(account.spendRateBps ?? 0), BPS);
        b = wd > b ? 0n : b - wd;
      }
    }
    out.push(fromBig(b));
  }
  return out;
}

export function projectNetWorth(params: {
  accounts: ProjectionAccount[];
  fromYear: number;
  toYear: number;
}): ProjectionPoint[] {
  const { accounts, fromYear, toYear } = params;
  if (toYear < fromYear) throw new Error("projectNetWorth: toYear must be >= fromYear");
  const span = toYear - fromYear;
  const youngestBirths = accounts.map((a) =>
    a.ownerBirthYears.length ? Math.max(...a.ownerBirthYears) : null,
  );
  // Each account's withdrawn balance series (offset 0..span).
  const series = accounts.map((a, i) => projectAccountSeries(a, span, fromYear, youngestBirths[i]));
  const points: ProjectionPoint[] = [];
  for (let offset = 0; offset <= span; offset++) {
    const year = fromYear + offset;
    let total = 0;
    let accessible = 0;
    accounts.forEach((a, i) => {
      const bal = series[i][offset];
      total += bal;
      const youngestBirth = youngestBirths[i];
      const age = youngestBirth === null ? Number.POSITIVE_INFINITY : year - youngestBirth;
      accessible += accessibleValueMinor(bal, age, a);
    });
    points.push({ year, totalBaseMinor: total, accessibleBaseMinor: accessible });
  }
  return points;
}
```

Note: `assertYears`, `BPS`, `toBig`, `fromBig`, `roundDiv`, `ProjectionPoint`, and `accessibleValueMinor` already exist in this file. `projectSeries` is unchanged.

- [ ] **Step 3: Update existing test fixtures + add withdrawal tests (write the failing tests)**

In `packages/shared/src/projection.test.ts`:

First, update the import on line 97 to include the new type:

```ts
import { projectNetWorth, projectAccountSeries, milestoneYears, type ProjectionAccount, type WithdrawalConfig } from "./projection";
```

Then add a shared `noSpend` fixture just after that import (line ~98):

```ts
const noSpend: WithdrawalConfig = {
  spendType: "none", spendAmountMinor: null, spendRateBps: null,
  spendStartKind: "age", spendStartAge: null, spendStartTargetMinor: null,
};
```

The three existing `ProjectionAccount` literals in this file (`cash`, `cpf`, `shared`, `noBirth` inside the `projectNetWorth` tests, lines ~108-145) now fail to typecheck because they lack the withdrawal fields. Add `...noSpend,` to each of those object literals. Example — the `cash` literal becomes:

```ts
const cash: ProjectionAccount = {
  baseMinor: 100_000, growthRateBps: 0, accessibleFromAge: 0,
  earlyWithdrawal: "none", earlyHaircutBps: 0, illiquid: false,
  liquidationAge: null, ownerBirthYears: [1990], ...noSpend,
};
```

Do the same (`...noSpend,`) for `cpf`, `shared`, and `noBirth`.

Now append these new tests to the end of the file:

```ts
// --- Withdrawals -----------------------------------------------------------

const liquidSpend = {
  accessibleFromAge: 0, earlyWithdrawal: "none" as const, earlyHaircutBps: 0,
  illiquid: false, liquidationAge: null, ...noSpend,
};

test("withdrawal none: identical to compound-only baseline", () => {
  const a: ProjectionAccount = {
    ...liquidSpend, baseMinor: 100_000, growthRateBps: 800, ownerBirthYears: [1990],
  };
  expect(projectAccountSeries(a, 2, 2030, 1990)).toEqual(projectSeries(100_000, 800, 2));
});

test("withdrawal once + age trigger: lump removed once, nothing after", () => {
  const a: ProjectionAccount = {
    ...liquidSpend, baseMinor: 100_000, growthRateBps: 0, ownerBirthYears: [1990],
    spendType: "once", spendAmountMinor: 30_000, spendStartKind: "age", spendStartAge: 60,
  };
  const pts = projectNetWorth({ accounts: [a], fromYear: 2049, toYear: 2051 });
  expect(pts.map((p) => p.totalBaseMinor)).toEqual([100_000, 70_000, 70_000]);
});

test("withdrawal monthly + age trigger: 12x amount per year from start", () => {
  const a: ProjectionAccount = {
    ...liquidSpend, baseMinor: 1_000_000, growthRateBps: 0, ownerBirthYears: [1990],
    spendType: "monthly", spendAmountMinor: 5_000, spendStartKind: "age", spendStartAge: 60,
  };
  const pts = projectNetWorth({ accounts: [a], fromYear: 2049, toYear: 2051 });
  expect(pts.map((p) => p.totalBaseMinor)).toEqual([1_000_000, 940_000, 880_000]);
});

test("withdrawal percent + age trigger: rate% of balance per year", () => {
  const a: ProjectionAccount = {
    ...liquidSpend, baseMinor: 1_000_000, growthRateBps: 0, ownerBirthYears: [1990],
    spendType: "percent", spendRateBps: 400, spendStartKind: "age", spendStartAge: 60,
  };
  const pts = projectNetWorth({ accounts: [a], fromYear: 2049, toYear: 2051 });
  expect(pts.map((p) => p.totalBaseMinor)).toEqual([1_000_000, 960_000, 921_600]);
});

test("withdrawal target trigger latches on the first year balance crosses target", () => {
  const a: ProjectionAccount = {
    ...liquidSpend, baseMinor: 100_000, growthRateBps: 800, ownerBirthYears: [],
    spendType: "once", spendAmountMinor: 10_000, spendStartKind: "target",
    spendStartTargetMinor: 120_000,
  };
  const series = projectAccountSeries(a, 4, 2030, null);
  // grow: 100000,108000,116640,125971 -> at 125971 (>=120000) withdraw 10000 -> 115971; then grow.
  expect(series).toEqual([100_000, 108_000, 116_640, 115_971, 125_249]);
});

test("withdrawal capped at available balance (floored at 0)", () => {
  const a: ProjectionAccount = {
    ...liquidSpend, baseMinor: 50_000, growthRateBps: 0, ownerBirthYears: [1990],
    spendType: "monthly", spendAmountMinor: 10_000, spendStartKind: "age", spendStartAge: 60,
  };
  const pts = projectNetWorth({ accounts: [a], fromYear: 2049, toYear: 2051 });
  expect(pts.map((p) => p.totalBaseMinor)).toEqual([50_000, 0, 0]);
});

test("age trigger never fires without an owner birth year", () => {
  const a: ProjectionAccount = {
    ...liquidSpend, baseMinor: 100_000, growthRateBps: 0, ownerBirthYears: [],
    spendType: "percent", spendRateBps: 400, spendStartKind: "age", spendStartAge: 60,
  };
  const pts = projectNetWorth({ accounts: [a], fromYear: 2049, toYear: 2051 });
  expect(pts.map((p) => p.totalBaseMinor)).toEqual([100_000, 100_000, 100_000]);
});

test("liabilities keep compounding negative; withdrawal config ignored", () => {
  const a: ProjectionAccount = {
    ...liquidSpend, baseMinor: -100_000, growthRateBps: 250, ownerBirthYears: [1990],
    spendType: "monthly", spendAmountMinor: 9_999, spendStartKind: "age", spendStartAge: 0,
  };
  const series = projectAccountSeries(a, 1, 2030, 1990);
  expect(series).toEqual([-100_000, -102_500]);
});
```

- [ ] **Step 4: Run the tests to verify they fail first, then pass**

Run: `cd /Users/aziz/Workspace/uang && bun test packages/shared/src/projection.test.ts`
Expected after Step 1-2 implementation: PASS (all old + new tests). If you ran tests before implementing Steps 1-2, expect FAIL with "projectAccountSeries is not a function" / type errors.

- [ ] **Step 5: Strict typecheck**

Run: `cd /Users/aziz/Workspace/uang/apps/web && bun run build`
Expected: `✓ built` with no type errors. (The chart still typechecks because its `ProjectionAccount` construction is updated in Task 6 — but it currently omits the new fields, so this build will FAIL until Task 6. That is expected; if you are running tasks strictly in order, defer this step's success to after Task 6, but still run `bun test` here.)

- [ ] **Step 6: Commit**

```bash
cd /Users/aziz/Workspace/uang
git add packages/shared/src/projection.ts packages/shared/src/projection.test.ts
git commit -m "feat(shared): withdrawal-aware net-worth projection"
```

---

## Task 2: Database columns + migration

**Files:**
- Modify: `apps/api/src/db/schema.ts:13-32` (accounts table)
- Create: `apps/api/drizzle/0008_*.sql` (generated)

- [ ] **Step 1: Add the six columns to the `accounts` table**

In `apps/api/src/db/schema.ts`, inside the `accounts` table definition, after the `liquidationAge` line (line 28) add:

```ts
  // Decumulation (withdrawals) for projections. 'none' = pure accumulation.
  spendType: text("spend_type", { enum: ["none", "once", "monthly", "percent"] })
    .notNull()
    .default("none"),
  spendAmountMinor: integer("spend_amount_minor"), // base minor: 'once' lump / 'monthly' per-month; null otherwise
  spendRateBps: integer("spend_rate_bps"),         // 'percent' annual % of balance (400 = 4%/yr); null otherwise
  spendStartKind: text("spend_start_kind", { enum: ["age", "target"] })
    .notNull()
    .default("age"),
  spendStartAge: integer("spend_start_age"),               // when spendStartKind = 'age'
  spendStartTargetMinor: integer("spend_start_target_minor"), // base minor; when spendStartKind = 'target'
```

- [ ] **Step 2: Generate the migration**

Run: `cd /Users/aziz/Workspace/uang && bun run db:generate`
Expected: a new file `apps/api/drizzle/0008_<random>.sql` containing `ALTER TABLE accounts ADD ...` statements for the six columns, plus updated `apps/api/drizzle/meta/*`.

- [ ] **Step 3: Apply + verify it loads**

Run: `cd /Users/aziz/Workspace/uang && bun run db:migrate`
Expected: prints `migrations applied` with no error. (Migrations also auto-run on API startup.)

- [ ] **Step 4: Commit**

```bash
cd /Users/aziz/Workspace/uang
git add apps/api/src/db/schema.ts apps/api/drizzle
git commit -m "feat(db): account spend/withdrawal columns + migration"
```

---

## Task 3: Accounts API — accept and persist the new fields

**Files:**
- Modify: `apps/api/src/routes/accounts.ts` (POST body+insert ~40-88, PATCH body+update ~131-163)

- [ ] **Step 1: POST — persist new fields on insert**

In the POST handler's `db.insert(accounts).values({ ... })` (ends at line 58), after the `liquidationAge:` line add:

```ts
          spendType: body.spendType ?? "none",
          spendAmountMinor: body.spendAmountMinor ?? null,
          spendRateBps: body.spendRateBps ?? null,
          spendStartKind: body.spendStartKind ?? "age",
          spendStartAge: body.spendStartAge ?? null,
          spendStartTargetMinor: body.spendStartTargetMinor ?? null,
```

- [ ] **Step 2: POST — extend the body validator**

In the POST `body: t.Object({ ... })` (ends ~line 87), after the `liquidationAge:` validator line add:

```ts
        spendType: t.Optional(t.Union([t.Literal("none"), t.Literal("once"), t.Literal("monthly"), t.Literal("percent")])),
        spendAmountMinor: t.Optional(t.Union([t.Number(), t.Null()])),
        spendRateBps: t.Optional(t.Union([t.Number(), t.Null()])),
        spendStartKind: t.Optional(t.Union([t.Literal("age"), t.Literal("target")])),
        spendStartAge: t.Optional(t.Union([t.Number(), t.Null()])),
        spendStartTargetMinor: t.Optional(t.Union([t.Number(), t.Null()])),
```

- [ ] **Step 3: PATCH — apply new fields on update**

In the PATCH handler's update builder (ends ~line 145), after the `if (body.liquidationAge !== undefined) update.liquidationAge = body.liquidationAge;` line add:

```ts
      if (body.spendType !== undefined) update.spendType = body.spendType;
      if (body.spendAmountMinor !== undefined) update.spendAmountMinor = body.spendAmountMinor;
      if (body.spendRateBps !== undefined) update.spendRateBps = body.spendRateBps;
      if (body.spendStartKind !== undefined) update.spendStartKind = body.spendStartKind;
      if (body.spendStartAge !== undefined) update.spendStartAge = body.spendStartAge;
      if (body.spendStartTargetMinor !== undefined) update.spendStartTargetMinor = body.spendStartTargetMinor;
```

- [ ] **Step 4: PATCH — extend the body validator**

In the PATCH `body: t.Object({ ... })` (ends ~line 162), after the `liquidationAge:` validator line add the same six validator lines as Step 2.

- [ ] **Step 5: Typecheck**

Run: `cd /Users/aziz/Workspace/uang/apps/api && bunx tsc --noEmit` (or rely on Task 7's web build).
Expected: no errors. If `tsc` config is absent, skip — the web build in Task 7 will catch type breaks across the Eden boundary.

- [ ] **Step 6: Commit**

```bash
cd /Users/aziz/Workspace/uang
git add apps/api/src/routes/accounts.ts
git commit -m "feat(api): accounts accept spend/withdrawal fields"
```

---

## Task 4: `/networth` payload exposes the new fields

**Files:**
- Modify: `apps/api/src/lib/valuation.ts` (`AccountValuation` type ~50-62, `netWorth` push ~before close)

- [ ] **Step 1: Extend the `AccountValuation` type**

In `apps/api/src/lib/valuation.ts`, in the `AccountValuation` type, after the `liquidationAge: number | null;` line add:

```ts
  spendType: "none" | "once" | "monthly" | "percent";
  spendAmountMinor: number | null;
  spendRateBps: number | null;
  spendStartKind: "age" | "target";
  spendStartAge: number | null;
  spendStartTargetMinor: number | null;
```

- [ ] **Step 2: Include the fields in the `netWorth` account payload**

In the `out.push({ ... })` block inside `netWorth`, after the `liquidationAge: a.liquidationAge ?? null,` line add:

```ts
      spendType: a.spendType,
      spendAmountMinor: a.spendAmountMinor ?? null,
      spendRateBps: a.spendRateBps ?? null,
      spendStartKind: a.spendStartKind,
      spendStartAge: a.spendStartAge ?? null,
      spendStartTargetMinor: a.spendStartTargetMinor ?? null,
```

- [ ] **Step 3: Commit**

```bash
cd /Users/aziz/Workspace/uang
git add apps/api/src/lib/valuation.ts
git commit -m "feat(api): expose spend/withdrawal fields on /networth"
```

---

## Task 5: Web collection — send the new fields on insert/update

**Files:**
- Modify: `apps/web/src/lib/collections.ts:54-69` (onInsert payload), `:75-87` (onUpdate payload)
- Modify: `apps/web/src/components/account-form.tsx:47-67` (optimistic insert row)

Note: `AccountRow` is inferred from `api.accounts.get`, so the type updates automatically once Task 4 lands — no manual type edit. But every place that *constructs* an `AccountRow` or sends a curated payload must include the new fields.

- [ ] **Step 1: onInsert payload**

In `apps/web/src/lib/collections.ts`, in `accountsCollection`'s `onInsert`, in the `api.accounts.post({ ... })` call, after `liquidationAge: m.liquidationAge ?? null,` add:

```ts
        spendType: m.spendType,
        spendAmountMinor: m.spendAmountMinor,
        spendRateBps: m.spendRateBps,
        spendStartKind: m.spendStartKind,
        spendStartAge: m.spendStartAge,
        spendStartTargetMinor: m.spendStartTargetMinor,
```

- [ ] **Step 2: onUpdate payload**

In the same file, in `onUpdate`'s `api.accounts({ id: m.id }).patch({ ... })` call, after `liquidationAge: m.liquidationAge ?? null,` add the same six lines as Step 1.

- [ ] **Step 3: Add spend defaults to the add-account optimistic row**

In `apps/web/src/components/account-form.tsx`, in the `const row: AccountRow = { ... }` literal, after `liquidationAge: assumptions.liquidationAge,` (line 66) add:

```ts
      spendType: "none",
      spendAmountMinor: null,
      spendRateBps: null,
      spendStartKind: "age",
      spendStartAge: null,
      spendStartTargetMinor: null,
```

- [ ] **Step 4: Commit** (typecheck happens in Task 7's build)

```bash
cd /Users/aziz/Workspace/uang
git add apps/web/src/lib/collections.ts apps/web/src/components/account-form.tsx
git commit -m "feat(web): send spend/withdrawal fields from accounts collection"
```

---

## Task 6: Feed withdrawals into the projection chart

**Files:**
- Modify: `apps/web/src/components/projection-chart.tsx` (`NwAccount` type ~16-26, `projAccounts` map ~62-73)

- [ ] **Step 1: Extend the `NwAccount` type**

In `apps/web/src/components/projection-chart.tsx`, in the `NwAccount` type, after `liquidationAge: number | null;` add:

```ts
  spendType: "none" | "once" | "monthly" | "percent";
  spendAmountMinor: number | null;
  spendRateBps: number | null;
  spendStartKind: "age" | "target";
  spendStartAge: number | null;
  spendStartTargetMinor: number | null;
```

- [ ] **Step 2: Map the fields into `ProjectionAccount`**

In the `projAccounts` map, in the returned object, after the `ownerBirthYears: ...` block add:

```ts
      spendType: a.spendType,
      spendAmountMinor: a.spendAmountMinor,
      spendRateBps: a.spendRateBps,
      spendStartKind: a.spendStartKind,
      spendStartAge: a.spendStartAge,
      spendStartTargetMinor: a.spendStartTargetMinor,
```

- [ ] **Step 3: Strict typecheck (now the full chain compiles)**

Run: `cd /Users/aziz/Workspace/uang/apps/web && bun run build`
Expected: `✓ built`, no type errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/aziz/Workspace/uang
git add apps/web/src/components/projection-chart.tsx
git commit -m "feat(web): projection chart reflects per-account withdrawals"
```

---

## Task 7: Consolidated per-account card (assumptions + withdrawal)

**Files:**
- Modify (full rewrite): `apps/web/src/components/account-projection-card.tsx`

- [ ] **Step 1: Replace the file contents**

Overwrite `apps/web/src/components/account-projection-card.tsx` with:

```tsx
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { currencyDecimals } from "@uang/shared";
import { accountsCollection, type AccountRow } from "@/lib/collections";
import { formatMoney } from "@/components/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { KVRow, Field } from "@/components/account-info-card";
import { SectionCard } from "@/components/section-card";

// UI shows percent; storage is basis points.
const toPct = (bps: number) => String(bps / 100);
const fromPct = (s: string) => Math.round((parseFloat(s) || 0) * 100);
// Withdrawal amounts are in BASE currency.
const toMajor = (minor: number, currency: string) =>
  String(minor / 10 ** currencyDecimals(currency));
const toMinor = (major: string, currency: string) =>
  Math.round((parseFloat(major) || 0) * 10 ** currencyDecimals(currency));

type SpendType = AccountRow["spendType"];
type SpendStartKind = AccountRow["spendStartKind"];

const SPEND_LABELS: Record<SpendType, string> = {
  none: "None (no withdrawal)",
  once: "One-time withdrawal",
  monthly: "Monthly income",
  percent: "% of balance / yr",
};

function seedForm(account: AccountRow, base: string) {
  return {
    growthPct: toPct(account.growthRateBps),
    accessibleFromAge: String(account.accessibleFromAge),
    earlyWithdrawal: account.earlyWithdrawal,
    earlyHaircutPct: toPct(account.earlyHaircutBps),
    illiquid: account.illiquid === 1,
    liquidationAge: account.liquidationAge == null ? "" : String(account.liquidationAge),
    spendType: account.spendType,
    spendAmount: account.spendAmountMinor == null ? "" : toMajor(account.spendAmountMinor, base),
    spendRate: account.spendRateBps == null ? "" : toPct(account.spendRateBps),
    spendStartKind: account.spendStartKind,
    spendStartAge: account.spendStartAge == null ? "" : String(account.spendStartAge),
    spendStartTarget:
      account.spendStartTargetMinor == null ? "" : toMajor(account.spendStartTargetMinor, base),
  };
}

// How this account behaves in the long-term net-worth forecast: growth, when the
// money becomes accessible, liquidity, and decumulation (withdrawals). Read view +
// inline edit. Lives on /projections (one card per account). Amounts are base currency.
export function AccountProjectionCard({
  account,
  baseCurrency,
}: {
  account: AccountRow;
  baseCurrency: string;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState(() => seedForm(account, baseCurrency));
  const isLiability = account.class === "liability";

  function openEdit() {
    setF(seedForm(account, baseCurrency));
    setEditing(true);
  }
  function cancel() {
    setEditing(false);
  }

  async function save() {
    accountsCollection.update(account.id, (draft) => {
      draft.growthRateBps = fromPct(f.growthPct);
      draft.accessibleFromAge = parseInt(f.accessibleFromAge, 10) || 0;
      draft.earlyWithdrawal = f.earlyWithdrawal;
      draft.earlyHaircutBps = fromPct(f.earlyHaircutPct);
      draft.illiquid = f.illiquid ? 1 : 0;
      draft.liquidationAge = f.liquidationAge === "" ? null : parseInt(f.liquidationAge, 10);
      // Decumulation. Liabilities never withdraw.
      const spendType: SpendType = isLiability ? "none" : f.spendType;
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
    await qc.invalidateQueries({ queryKey: ["networth"] });
    setEditing(false);
  }

  const accessible =
    account.accessibleFromAge > 0 ? `From age ${account.accessibleFromAge}` : "Any time";
  const beforeAge =
    account.accessibleFromAge > 0
      ? account.earlyWithdrawal === "penalty"
        ? `Withdraw with ${toPct(account.earlyHaircutBps)}% penalty`
        : "Locked"
      : null;
  const liquidity =
    account.illiquid === 1
      ? account.liquidationAge != null
        ? `Illiquid · liquidates at age ${account.liquidationAge}`
        : "Illiquid"
      : "Liquid";

  const withdrawalSummary = (() => {
    if (account.spendType === "none") return "None";
    const when =
      account.spendStartKind === "age"
        ? account.spendStartAge != null
          ? `from age ${account.spendStartAge}`
          : "—"
        : account.spendStartTargetMinor != null
          ? `once balance hits ${formatMoney(account.spendStartTargetMinor, baseCurrency)}`
          : "—";
    if (account.spendType === "percent") return `${toPct(account.spendRateBps ?? 0)}%/yr ${when}`;
    if (account.spendType === "monthly")
      return `${formatMoney(account.spendAmountMinor ?? 0, baseCurrency)}/mo ${when}`;
    return `${formatMoney(account.spendAmountMinor ?? 0, baseCurrency)} once ${when}`;
  })();

  return (
    <SectionCard title={account.name} editing={editing} onToggle={editing ? cancel : openEdit}>
      {!editing && (
        <div className="py-1.5">
          <KVRow label="Growth" value={`${toPct(account.growthRateBps)}% / year`} />
          <KVRow label="Accessible" value={accessible} />
          {beforeAge && <KVRow label="Before" value={beforeAge} />}
          <KVRow label="Liquidity" value={liquidity} />
          {!isLiability && <KVRow label="Withdrawal" value={withdrawalSummary} />}
        </div>
      )}

      {editing && (
        <div>
          <div className="flex flex-col gap-4 p-4">
            <div className="grid grid-cols-2 gap-4">
              <Field label="Annual growth %">
                <Input
                  type="number"
                  step="any"
                  value={f.growthPct}
                  onChange={(e) => setF((p) => ({ ...p, growthPct: e.target.value }))}
                />
              </Field>
              <Field label="Accessible from age">
                <Input
                  type="number"
                  min="0"
                  value={f.accessibleFromAge}
                  onChange={(e) => setF((p) => ({ ...p, accessibleFromAge: e.target.value }))}
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Before that age">
                <Select
                  value={f.earlyWithdrawal}
                  onValueChange={(v: string | null) =>
                    v && setF((p) => ({ ...p, earlyWithdrawal: v as AccountRow["earlyWithdrawal"] }))
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue>
                      {(v: unknown) => (String(v) === "penalty" ? "Withdraw with penalty" : "Locked")}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Locked</SelectItem>
                    <SelectItem value="penalty">Withdraw with penalty</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Early penalty %">
                <Input
                  type="number"
                  min="0"
                  step="any"
                  value={f.earlyHaircutPct}
                  disabled={f.earlyWithdrawal !== "penalty"}
                  onChange={(e) => setF((p) => ({ ...p, earlyHaircutPct: e.target.value }))}
                />
              </Field>
            </div>
            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <span className="text-sm">Illiquid (exclude from accessible)</span>
              <Switch
                checked={f.illiquid}
                onCheckedChange={(v: boolean) => setF((p) => ({ ...p, illiquid: v }))}
              />
            </div>
            {f.illiquid && (
              <Field label="Liquidation age (optional)">
                <Input
                  type="number"
                  min="0"
                  value={f.liquidationAge}
                  placeholder="never"
                  onChange={(e) => setF((p) => ({ ...p, liquidationAge: e.target.value }))}
                />
              </Field>
            )}

            {!isLiability && (
              <div className="grid grid-cols-2 gap-4 border-t border-border pt-4">
                <Field label="Withdrawal">
                  <Select
                    value={f.spendType}
                    onValueChange={(v: string | null) =>
                      v && setF((p) => ({ ...p, spendType: v as SpendType }))
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue>{(v: unknown) => SPEND_LABELS[v as SpendType]}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(SPEND_LABELS) as SpendType[]).map((k) => (
                        <SelectItem key={k} value={k}>
                          {SPEND_LABELS[k]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>

                {(f.spendType === "once" || f.spendType === "monthly") && (
                  <Field
                    label={
                      f.spendType === "once"
                        ? `Lump (${baseCurrency})`
                        : `Per month (${baseCurrency})`
                    }
                  >
                    <Input
                      type="number"
                      step="any"
                      min="0"
                      value={f.spendAmount}
                      onChange={(e) => setF((p) => ({ ...p, spendAmount: e.target.value }))}
                    />
                  </Field>
                )}

                {f.spendType === "percent" && (
                  <Field label="Withdrawal rate (%/yr)">
                    <Input
                      type="number"
                      step="any"
                      min="0"
                      placeholder="4"
                      value={f.spendRate}
                      onChange={(e) => setF((p) => ({ ...p, spendRate: e.target.value }))}
                    />
                  </Field>
                )}

                {f.spendType !== "none" && (
                  <>
                    <Field label="Starts on">
                      <Select
                        value={f.spendStartKind}
                        onValueChange={(v: string | null) =>
                          v && setF((p) => ({ ...p, spendStartKind: v as SpendStartKind }))
                        }
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue>
                            {(v: unknown) =>
                              String(v) === "target" ? "Target balance" : "Owner age"
                            }
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="age">Owner age</SelectItem>
                          <SelectItem value="target">Target balance</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                    {f.spendStartKind === "age" ? (
                      <Field label="Start at age">
                        <Input
                          type="number"
                          min="0"
                          value={f.spendStartAge}
                          onChange={(e) => setF((p) => ({ ...p, spendStartAge: e.target.value }))}
                        />
                      </Field>
                    ) : (
                      <Field label={`Target balance (${baseCurrency})`}>
                        <Input
                          type="number"
                          step="any"
                          min="0"
                          value={f.spendStartTarget}
                          onChange={(e) => setF((p) => ({ ...p, spendStartTarget: e.target.value }))}
                        />
                      </Field>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
          <div className="flex gap-2 border-t border-border bg-muted px-4 py-3">
            <Button size="sm" onClick={save}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </SectionCard>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd /Users/aziz/Workspace/uang/apps/web && bun run build`
Expected: FAIL — `account-detail.tsx` still renders `<AccountProjectionCard account={account} />` without the now-required `baseCurrency` prop. That is fixed in Task 9. If running strictly in order, proceed; the build goes green at the end of Task 9. (To verify this file in isolation, temporarily check just this module compiles, then continue.)

- [ ] **Step 3: Commit**

```bash
cd /Users/aziz/Workspace/uang
git add apps/web/src/components/account-projection-card.tsx
git commit -m "feat(web): consolidated per-account projection + withdrawal card"
```

---

## Task 8: Render per-account cards on /projections

**Files:**
- Modify: `apps/web/src/routes/projections.tsx`

- [ ] **Step 1: Add imports**

At the top of `apps/web/src/routes/projections.tsx`, update/add imports so the file has:

```tsx
import { useLiveQuery } from "@tanstack/react-db";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { accountsCollection, membersCollection } from "@/lib/collections";
import { ProjectionChart } from "@/components/projection-chart";
import { AccountProjectionCard } from "@/components/account-projection-card";
import { AppShell, Eyebrow, Section } from "@/components/app-layout";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
```

(`useLiveQuery`, `useQuery`, `useQueryClient`, `api`, `membersCollection`, `ProjectionChart`, `AppShell`, `Section`, `Input`, `Label` are already imported from earlier work — just add `accountsCollection`, `AccountProjectionCard`, and `Eyebrow`.)

- [ ] **Step 2: Add the per-account section component**

Add this component above `ProjectionsPage` in `projections.tsx`:

```tsx
function PerAccountSection() {
  const { data: accounts = [] } = useLiveQuery(accountsCollection);
  const settingsQ = useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const { data, error } = await api.settings.get();
      if (error) throw new Error(String(error));
      return data as unknown as { baseCurrency: string };
    },
  });
  const base = settingsQ.data?.baseCurrency;
  const visible = accounts
    .filter((a) => a.isArchived === 0)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  if (!base || visible.length === 0) return null;

  return (
    <div className="space-y-4">
      <Eyebrow>Per account</Eyebrow>
      {visible.map((a) => (
        <AccountProjectionCard key={a.id} account={a} baseCurrency={base} />
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Render it in the page**

In `ProjectionsPage`'s returned JSX, add `<PerAccountSection />` as the last child of the `<div className="space-y-5">` wrapper (after `<ProjectionAssumptionsSection />`):

```tsx
        <ProjectionChart />
        <PerAccountSection />
        <MembersSection />
        <ProjectionAssumptionsSection />
```

(Order: chart, then per-account withdrawal cards, then birth years, then assumptions.)

- [ ] **Step 4: Commit** (full build verified in Task 9)

```bash
cd /Users/aziz/Workspace/uang
git add apps/web/src/routes/projections.tsx
git commit -m "feat(web): per-account withdrawal cards on /projections"
```

---

## Task 9: Remove the projection card from the account detail page

**Files:**
- Modify: `apps/web/src/routes/account-detail.tsx` (import line 13, Details tab ~194-200)

- [ ] **Step 1: Remove the import**

In `apps/web/src/routes/account-detail.tsx`, delete line 13:

```tsx
import { AccountProjectionCard } from "@/components/account-projection-card";
```

- [ ] **Step 2: Drop the card from the Details tab**

Replace the Details `TabsContent` grid (lines ~194-200) — which currently renders `AccountInfoCard` + `AccountProjectionCard` side by side — with just the info card:

```tsx
        <TabsContent value="details" className="mt-5">
          <AccountInfoCard account={account} />
          {dangerZone}
        </TabsContent>
```

- [ ] **Step 3: Full strict typecheck + tests**

Run: `cd /Users/aziz/Workspace/uang/apps/web && bun run build`
Expected: `✓ built`, no type errors (the `baseCurrency`-prop break from Task 7 is now resolved).

Run: `cd /Users/aziz/Workspace/uang && bun test`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
cd /Users/aziz/Workspace/uang
git add apps/web/src/routes/account-detail.tsx
git commit -m "refactor(web): move projection card off account detail to /projections"
```

---

## Final verification

- [ ] `cd /Users/aziz/Workspace/uang/apps/web && bun run build` → `✓ built`, no type errors.
- [ ] `cd /Users/aziz/Workspace/uang && bun test` → all pass (incl. new withdrawal tests).
- [ ] Manual smoke (run the app): on `/projections`, expand an asset account's card, set Withdrawal = `% of balance / yr`, rate `4`, Starts on = Owner age, Start at age `60`. Ensure a member birth year is set so the owner reaches 60 within the horizon. Confirm: the Total/Accessible curve bends downward after that year; the card's read view shows `4%/yr from age 60`; liability accounts show no Withdrawal row.
- [ ] `/accounts/:id` → Details tab shows only the info card + danger zone (no projection card).
```
