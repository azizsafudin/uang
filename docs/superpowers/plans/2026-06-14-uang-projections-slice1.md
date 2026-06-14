# Projections — Slice 1 (Projected Net-Worth Curve) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a projected net-worth curve — each account grows at its own assumed rate, the chart shows total vs *accessible* net worth over calendar years, with per-person unlock milestones (55/62/65) marked.

**Architecture:** Pure projection math lives in `packages/shared` (BigInt, integer minor units, banker's rounding — same discipline as `money.ts`/`valuation.ts`). The API extends `netWorth()` to expose per-account growth/accessibility config + adds a `member_profiles` table and `/members` route. The web app computes the curve client-side from the `/networth` response + members, renders it with Recharts, and lets the user edit assumptions per account and birth years per member.

**Tech Stack:** Bun + ElysiaJS + Drizzle (SQLite) on the API; React + TanStack Router/Query/DB + Recharts + shadcn/ui on the web; `bun:test` for unit tests.

**Spec:** `docs/superpowers/specs/2026-06-14-uang-projections-design.md` (slices 1 only here; goals = slice 2, separate plan).

**Conventions:** No `as any`. Rates/haircuts are integer **basis points** (8% = `800`). New UI components via the shadcn CLI. Frequent commits.

---

## File structure

**Create:**
- `packages/shared/src/projection.ts` — pure engine (compounding, accessibility, net-worth projection, milestones).
- `packages/shared/src/projection.test.ts` — engine unit tests.
- `apps/api/src/routes/members.ts` — GET/PATCH member birth years.
- `apps/api/src/routes/members.test.ts` — route tests.
- `apps/web/src/lib/assumptions.ts` — subtype → default projection assumptions.
- `apps/web/src/components/account-assumptions-dialog.tsx` — edit growth/accessibility on an account.
- `apps/web/src/components/projection-chart.tsx` — the curve.
- `apps/web/src/routes/projections.tsx` — `/projections` page.

**Modify:**
- `apps/api/src/db/schema.ts` — new account columns + `member_profiles` table.
- `apps/api/drizzle/*` — generated migration (via `db:generate`).
- `apps/api/src/lib/test-helpers.ts` — clear `member_profiles` in `resetDb`.
- `apps/api/src/lib/valuation.ts` — `AccountValuation` carries projection config.
- `apps/api/src/lib/valuation.test.ts` — assert new fields.
- `apps/api/src/routes/accounts.ts` — POST/PATCH accept projection fields.
- `apps/api/src/routes/accounts.test.ts` — assert round-trip.
- `apps/api/src/app.ts` — mount `membersRoutes`.
- `apps/web/src/lib/collections.ts` — send new account fields; add `membersCollection`.
- `apps/web/src/components/account-form.tsx` — seed assumptions on create.
- `apps/web/src/routes/account-detail.tsx` — open the assumptions dialog.
- `apps/web/src/routes/settings.tsx` — birth-year inputs per member.
- `apps/web/src/router.tsx` — register `/projections`.
- `apps/web/src/routes/dashboard.tsx` — link to `/projections`.

---

## Task 1: Shared — compounding primitives

**Files:**
- Create: `packages/shared/src/projection.ts`
- Test: `packages/shared/src/projection.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/projection.test.ts`:

```ts
import { expect, test } from "bun:test";
import { compoundMinor, projectSeries } from "./projection";

test("compoundMinor: zero years returns the input", () => {
  expect(compoundMinor(100_000, 800, 0)).toBe(100_000);
});

test("compoundMinor: 8% for 1 year", () => {
  expect(compoundMinor(100_000, 800, 1)).toBe(108_000);
});

test("compoundMinor: 8% for 2 years compounds (banker's rounding)", () => {
  // 100000 -> 108000 -> 116640
  expect(compoundMinor(100_000, 800, 2)).toBe(116_640);
});

test("compoundMinor: 0% leaves balance unchanged", () => {
  expect(compoundMinor(43_000_00, 0, 30)).toBe(43_000_00);
});

test("compoundMinor: negative balances (debt) grow more negative", () => {
  expect(compoundMinor(-100_000, 250, 1)).toBe(-102_500);
});

test("compoundMinor: rejects non-integer / negative years", () => {
  expect(() => compoundMinor(1, 0, -1)).toThrow();
  expect(() => compoundMinor(1, 0, 1.5)).toThrow();
});

test("projectSeries: returns offsets 0..years inclusive", () => {
  expect(projectSeries(100_000, 800, 2)).toEqual([100_000, 108_000, 116_640]);
});

test("projectSeries: contribution added at start of each year before growth", () => {
  // y1: (100000 + 10000) * 1.08 = 118800 ; y2: (118800 + 10000) * 1.08 = 139104
  expect(projectSeries(100_000, 800, 2, 10_000)).toEqual([100_000, 118_800, 139_104]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && bun test src/projection.test.ts`
Expected: FAIL — `Cannot find module './projection'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/shared/src/projection.ts`:

```ts
import { roundDiv, toBig, fromBig } from "./money";

// Rates and haircuts are integer basis points: 8% === 800, 100% === 10_000.
const BPS = 10_000n;

function assertYears(years: number): void {
  if (!Number.isInteger(years) || years < 0) {
    throw new Error("projection: years must be a non-negative integer");
  }
}

// Compound a starting balance (minor units, may be negative for debt) for `years`
// whole years at `growthRateBps` per year, banker's-rounded each year.
export function compoundMinor(balanceMinor: number, growthRateBps: number, years: number): number {
  assertYears(years);
  let b = toBig(balanceMinor);
  const factor = BPS + toBig(growthRateBps);
  for (let i = 0; i < years; i++) b = roundDiv(b * factor, BPS);
  return fromBig(b);
}

// Balance at each year offset 0..years inclusive. `contributionPerYear` (minor
// units) is added at the start of each year before that year's growth.
// Offset 0 is always the untouched starting balance (today).
export function projectSeries(
  balanceMinor: number,
  growthRateBps: number,
  years: number,
  contributionPerYear = 0,
): number[] {
  assertYears(years);
  const factor = BPS + toBig(growthRateBps);
  const contrib = toBig(contributionPerYear);
  let b = toBig(balanceMinor);
  const out: number[] = [fromBig(b)];
  for (let i = 1; i <= years; i++) {
    b = roundDiv((b + contrib) * factor, BPS);
    out.push(fromBig(b));
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/shared && bun test src/projection.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/projection.ts packages/shared/src/projection.test.ts
git commit -m "feat(shared): compounding primitives for projections"
```

---

## Task 2: Shared — accessibility valuation

**Files:**
- Modify: `packages/shared/src/projection.ts`
- Test: `packages/shared/src/projection.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/projection.test.ts`:

```ts
import { accessibleValueMinor, type AccessibilityConfig } from "./projection";

const liquid: AccessibilityConfig = {
  accessibleFromAge: 0, earlyWithdrawal: "none", earlyHaircutBps: 0,
  illiquid: false, liquidationAge: null,
};
const srs: AccessibilityConfig = {
  accessibleFromAge: 62, earlyWithdrawal: "penalty", earlyHaircutBps: 500,
  illiquid: false, liquidationAge: null,
};
const cpf: AccessibilityConfig = {
  accessibleFromAge: 55, earlyWithdrawal: "none", earlyHaircutBps: 0,
  illiquid: false, liquidationAge: null,
};
const property: AccessibilityConfig = {
  accessibleFromAge: 0, earlyWithdrawal: "none", earlyHaircutBps: 0,
  illiquid: true, liquidationAge: null,
};

test("liquid account is fully accessible at any age", () => {
  expect(accessibleValueMinor(100_000, 30, liquid)).toBe(100_000);
});

test("liabilities reduce accessible (negative passes through when liquid)", () => {
  expect(accessibleValueMinor(-50_000, 40, liquid)).toBe(-50_000);
});

test("SRS before free age: 5% penalty haircut", () => {
  expect(accessibleValueMinor(100_000, 50, srs)).toBe(95_000);
});

test("SRS at/after free age: full", () => {
  expect(accessibleValueMinor(100_000, 62, srs)).toBe(100_000);
});

test("CPF before 55 with earlyWithdrawal none: locked (0)", () => {
  expect(accessibleValueMinor(100_000, 40, cpf)).toBe(0);
});

test("CPF at 55: full", () => {
  expect(accessibleValueMinor(100_000, 55, cpf)).toBe(100_000);
});

test("illiquid is excluded until liquidationAge", () => {
  expect(accessibleValueMinor(700_000, 40, property)).toBe(0);
  expect(accessibleValueMinor(700_000, 40, { ...property, liquidationAge: 38 })).toBe(700_000);
});

test("infinite age (no birth year) treats age-gated as accessible", () => {
  expect(accessibleValueMinor(100_000, Number.POSITIVE_INFINITY, cpf)).toBe(100_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && bun test src/projection.test.ts`
Expected: FAIL — `accessibleValueMinor` / `AccessibilityConfig` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/shared/src/projection.ts`:

```ts
export type EarlyWithdrawal = "none" | "penalty";

export type AccessibilityConfig = {
  accessibleFromAge: number;
  earlyWithdrawal: EarlyWithdrawal;
  earlyHaircutBps: number;
  illiquid: boolean;
  liquidationAge: number | null;
};

// Withdrawable value of a balance at a given owner age. Slice 1 has no late
// haircut (tax deferred), so at/after the free age the full balance counts.
export function accessibleValueMinor(
  balanceMinor: number,
  ownerAge: number,
  c: AccessibilityConfig,
): number {
  if (c.illiquid) {
    return c.liquidationAge !== null && ownerAge >= c.liquidationAge ? balanceMinor : 0;
  }
  if (ownerAge >= c.accessibleFromAge) return balanceMinor;
  if (c.earlyWithdrawal === "penalty") {
    return fromBig(roundDiv(toBig(balanceMinor) * (BPS - toBig(c.earlyHaircutBps)), BPS));
  }
  return 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/shared && bun test src/projection.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/projection.ts packages/shared/src/projection.test.ts
git commit -m "feat(shared): accessibility valuation (free age, penalty, illiquid)"
```

---

## Task 3: Shared — projectNetWorth + milestones, export from index

**Files:**
- Modify: `packages/shared/src/projection.ts`, `packages/shared/src/index.ts`
- Test: `packages/shared/src/projection.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/projection.test.ts`:

```ts
import { projectNetWorth, milestoneYears, type ProjectionAccount } from "./projection";

test("milestoneYears: default 55/62/65", () => {
  expect(milestoneYears(1990)).toEqual([
    { age: 55, year: 2045 },
    { age: 62, year: 2052 },
    { age: 65, year: 2055 },
  ]);
});

test("projectNetWorth: total grows; accessible respects unlocks", () => {
  const cash: ProjectionAccount = {
    baseMinor: 100_000, growthRateBps: 0, accessibleFromAge: 0,
    earlyWithdrawal: "none", earlyHaircutBps: 0, illiquid: false,
    liquidationAge: null, ownerBirthYears: [1990],
  };
  const cpf: ProjectionAccount = {
    baseMinor: 100_000, growthRateBps: 0, accessibleFromAge: 55,
    earlyWithdrawal: "none", earlyHaircutBps: 0, illiquid: false,
    liquidationAge: null, ownerBirthYears: [1990],
  };
  // 2030: owner age 40 -> CPF locked. 2045: owner age 55 -> CPF unlocks.
  const pts = projectNetWorth({ accounts: [cash, cpf], fromYear: 2030, toYear: 2045 });
  expect(pts[0]).toEqual({ year: 2030, totalBaseMinor: 200_000, accessibleBaseMinor: 100_000 });
  expect(pts[pts.length - 1]).toEqual({ year: 2045, totalBaseMinor: 200_000, accessibleBaseMinor: 200_000 });
});

test("projectNetWorth: shared account uses the youngest owner's age", () => {
  const shared: ProjectionAccount = {
    baseMinor: 100_000, growthRateBps: 0, accessibleFromAge: 55,
    earlyWithdrawal: "none", earlyHaircutBps: 0, illiquid: false,
    liquidationAge: null, ownerBirthYears: [1980, 1990], // youngest born 1990
  };
  const pts = projectNetWorth({ accounts: [shared], fromYear: 2040, toYear: 2045 });
  // 2040: younger is 50 -> locked. 2045: younger is 55 -> unlocked.
  expect(pts[0].accessibleBaseMinor).toBe(0);
  expect(pts[pts.length - 1].accessibleBaseMinor).toBe(100_000);
});

test("projectNetWorth: rejects inverted range", () => {
  expect(() => projectNetWorth({ accounts: [], fromYear: 2050, toYear: 2040 })).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && bun test src/projection.test.ts`
Expected: FAIL — `projectNetWorth` / `milestoneYears` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/shared/src/projection.ts`:

```ts
export type ProjectionAccount = AccessibilityConfig & {
  baseMinor: number;      // current base-currency balance (signed)
  growthRateBps: number;
  ownerBirthYears: number[]; // owners' birth years; empty = unknown
};

export type ProjectionPoint = {
  year: number;
  totalBaseMinor: number;
  accessibleBaseMinor: number;
};

export function projectNetWorth(params: {
  accounts: ProjectionAccount[];
  fromYear: number;
  toYear: number;
}): ProjectionPoint[] {
  const { accounts, fromYear, toYear } = params;
  if (toYear < fromYear) throw new Error("projectNetWorth: toYear must be >= fromYear");
  const span = toYear - fromYear;
  // Precompute each account's balance series once (offset 0..span).
  const series = accounts.map((a) => projectSeries(a.baseMinor, a.growthRateBps, span));
  const points: ProjectionPoint[] = [];
  for (let offset = 0; offset <= span; offset++) {
    const year = fromYear + offset;
    let total = 0;
    let accessible = 0;
    accounts.forEach((a, i) => {
      const bal = series[i][offset];
      total += bal;
      // Youngest owner (largest birth year) is the binding constraint for unlocks.
      const youngestBirth = a.ownerBirthYears.length ? Math.max(...a.ownerBirthYears) : null;
      const age = youngestBirth === null ? Number.POSITIVE_INFINITY : year - youngestBirth;
      accessible += accessibleValueMinor(bal, age, a);
    });
    points.push({ year, totalBaseMinor: total, accessibleBaseMinor: accessible });
  }
  return points;
}

// Calendar years a person reaches each milestone age.
export function milestoneYears(
  birthYear: number,
  ages: number[] = [55, 62, 65],
): { age: number; year: number }[] {
  return ages.map((age) => ({ age, year: birthYear + age }));
}
```

Add to `packages/shared/src/index.ts`:

```ts
export * from "./projection";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/shared && bun test src/projection.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/projection.ts packages/shared/src/projection.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): projectNetWorth + milestone years; export engine"
```

---

## Task 4: API — schema columns + member_profiles table + migration

**Files:**
- Modify: `apps/api/src/db/schema.ts`, `apps/api/src/lib/test-helpers.ts`
- Create: generated migration under `apps/api/drizzle/`

- [ ] **Step 1: Add columns + table to schema**

In `apps/api/src/db/schema.ts`, replace the `accounts` table definition with the version below (adds six columns; keeps everything else):

```ts
export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  class: text("class").$type<"asset" | "liability">().notNull(),
  subtype: text("subtype").notNull(),
  currency: text("currency").notNull(),
  valuationMode: text("valuation_mode").$type<"ledger" | "holdings">().notNull(),
  institution: text("institution"),
  isArchived: integer("is_archived").notNull().default(0),
  sortOrder: integer("sort_order").notNull().default(0),
  // Projection assumptions (slice 1). Rates/haircuts in basis points.
  growthRateBps: integer("growth_rate_bps").notNull().default(0),
  accessibleFromAge: integer("accessible_from_age").notNull().default(0),
  earlyWithdrawal: text("early_withdrawal").$type<"none" | "penalty">().notNull().default("none"),
  earlyHaircutBps: integer("early_haircut_bps").notNull().default(0),
  illiquid: integer("illiquid").notNull().default(0),
  liquidationAge: integer("liquidation_age"),
  createdAt: integer("created_at").notNull(),
  createdBy: text("created_by").notNull(),
});
```

Add the new table after `accountOwners` (before the `export * from "./auth-schema"` line):

```ts
// One row per household member holding projection inputs that aren't on the auth user.
export const memberProfiles = sqliteTable("member_profiles", {
  userId: text("user_id").primaryKey(), // FK -> user.id
  birthYear: integer("birth_year"),
});
```

- [ ] **Step 2: Generate the migration**

Run: `cd apps/api && bun run db:generate`
Expected: a new file `apps/api/drizzle/0002_*.sql` is created containing `ALTER TABLE accounts ADD ...` statements and `CREATE TABLE member_profiles ...`, and `drizzle/meta/_journal.json` is updated.

Verify it contains the new columns and table:

Run: `cd apps/api && cat drizzle/0002_*.sql`
Expected: includes `growth_rate_bps`, `accessible_from_age`, `early_withdrawal`, `early_haircut_bps`, `illiquid`, `liquidation_age`, and `CREATE TABLE \`member_profiles\``.

- [ ] **Step 3: Clear member_profiles in test reset**

In `apps/api/src/lib/test-helpers.ts`, add `memberProfiles` to the schema import and delete it in `resetDb`:

Change the import line to include `memberProfiles`:

```ts
import { settings, user, accounts, accountOwners, entries, fxRates, instruments, lots, prices, memberProfiles } from "../db/schema";
```

Add this line inside `resetDb`, right after `await db.delete(accountOwners);`:

```ts
  await db.delete(memberProfiles);
```

- [ ] **Step 4: Verify existing tests still pass against the migrated schema**

Run: `cd apps/api && bun test src/lib/valuation.test.ts src/routes/accounts.test.ts`
Expected: PASS (migration applies cleanly; defaults backfill existing rows).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle apps/api/src/lib/test-helpers.ts
git commit -m "feat(api): account projection columns + member_profiles table"
```

---

## Task 5: API — expose projection config from netWorth()

**Files:**
- Modify: `apps/api/src/lib/valuation.ts`
- Test: `apps/api/src/lib/valuation.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/lib/valuation.test.ts` (match the existing seeding style in that file; this test seeds one account with non-default assumptions and asserts they surface):

```ts
import { test, expect } from "bun:test";
import { db } from "../db/client";
import { accounts, settings } from "../db/schema";
import { createId, nowEpoch } from "./ids";
import { netWorth } from "./valuation";

test("netWorth exposes per-account projection config", async () => {
  // resetDb is registered in this file's existing beforeEach.
  await db.insert(settings).values({ id: 1, householdName: "H", baseCurrency: "USD", createdAt: nowEpoch() });
  const id = createId();
  await db.insert(accounts).values({
    id, name: "SRS", class: "asset", subtype: "investment", currency: "USD",
    valuationMode: "ledger", isArchived: 0, sortOrder: 0,
    growthRateBps: 800, accessibleFromAge: 62, earlyWithdrawal: "penalty",
    earlyHaircutBps: 500, illiquid: 0, liquidationAge: null,
    createdAt: nowEpoch(), createdBy: "seed",
  });

  const nw = await netWorth();
  const a = nw.accounts.find((x) => x.id === id)!;
  expect(a.growthRateBps).toBe(800);
  expect(a.accessibleFromAge).toBe(62);
  expect(a.earlyWithdrawal).toBe("penalty");
  expect(a.earlyHaircutBps).toBe(500);
  expect(a.illiquid).toBe(false);
  expect(a.liquidationAge).toBeNull();
});
```

> If `valuation.test.ts` has no `beforeEach(resetDb)`, add `import { resetDb } from "./test-helpers"; import { beforeEach } from "bun:test"; beforeEach(resetDb);` at the top (check first — it likely already imports them).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun test src/lib/valuation.test.ts`
Expected: FAIL — `growthRateBps` is `undefined` on the valuation.

- [ ] **Step 3: Implement**

In `apps/api/src/lib/valuation.ts`, extend the `AccountValuation` type:

```ts
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
```

In the same file, extend the `out.push({...})` call inside `netWorth()` (the object pushed for each account) to include the config from `a`:

```ts
    out.push({
      id: a.id, name: a.name, class: a.class, subtype: a.subtype, currency,
      balanceMinor, baseMinor, missingRate, ownerIds, shared,
      growthRateBps: a.growthRateBps,
      accessibleFromAge: a.accessibleFromAge,
      earlyWithdrawal: a.earlyWithdrawal,
      earlyHaircutBps: a.earlyHaircutBps,
      illiquid: a.illiquid === 1,
      liquidationAge: a.liquidationAge ?? null,
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && bun test src/lib/valuation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/valuation.ts apps/api/src/lib/valuation.test.ts
git commit -m "feat(api): surface projection config on netWorth accounts"
```

---

## Task 6: API — members route (birth years)

**Files:**
- Create: `apps/api/src/routes/members.ts`, `apps/api/src/routes/members.test.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/members.test.ts`:

```ts
import { expect, test, beforeEach } from "bun:test";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { membersRoutes } from "./members";

beforeEach(resetDb);

const app = makeApp(membersRoutes);

test("GET /members lists users with null birthYear by default", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const res = await app.handle(new Request("http://localhost/members", { headers: { cookie } }));
  expect(res.status).toBe(200);
  const members = await res.json();
  expect(members.length).toBe(1);
  expect(members[0].birthYear).toBeNull();
  expect(typeof members[0].id).toBe("string");
});

test("PATCH /members/:id sets and clears birthYear", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const list = await (await app.handle(new Request("http://localhost/members", { headers: { cookie } }))).json();
  const id = list[0].id;

  const set = await app.handle(new Request(`http://localhost/members/${id}`, {
    method: "PATCH", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ birthYear: 1990 }),
  }));
  expect(set.status).toBe(200);

  const after = await (await app.handle(new Request("http://localhost/members", { headers: { cookie } }))).json();
  expect(after[0].birthYear).toBe(1990);

  // Idempotent upsert: setting again updates in place.
  await app.handle(new Request(`http://localhost/members/${id}`, {
    method: "PATCH", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ birthYear: 1991 }),
  }));
  const after2 = await (await app.handle(new Request("http://localhost/members", { headers: { cookie } }))).json();
  expect(after2[0].birthYear).toBe(1991);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun test src/routes/members.test.ts`
Expected: FAIL — `Cannot find module './members'`.

- [ ] **Step 3: Implement the route**

Create `apps/api/src/routes/members.ts`:

```ts
import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { memberProfiles, user } from "../db/schema";
import { authGuard } from "../lib/auth-guard";

export const membersRoutes = new Elysia({ prefix: "/members" })
  .use(authGuard)
  .get("/", async () => {
    const users = await db.select().from(user);
    const profiles = await db.select().from(memberProfiles);
    const birthYearById = new Map(profiles.map((p) => [p.userId, p.birthYear]));
    return users.map((u) => ({
      id: u.id,
      name: u.name,
      birthYear: birthYearById.get(u.id) ?? null,
    }));
  })
  .patch(
    "/:id",
    async ({ params, body }) => {
      const birthYear = body.birthYear ?? null;
      await db
        .insert(memberProfiles)
        .values({ userId: params.id, birthYear })
        .onConflictDoUpdate({ target: memberProfiles.userId, set: { birthYear } });
      return { ok: true };
    },
    { body: t.Object({ birthYear: t.Union([t.Number(), t.Null()]) }) },
  );
```

Mount it in `apps/api/src/app.ts`: add the import near the other route imports:

```ts
import { membersRoutes } from "./routes/members";
```

and add `.use(membersRoutes)` to the chain (e.g., right after `.use(usersRoutes)`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && bun test src/routes/members.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/members.ts apps/api/src/routes/members.test.ts apps/api/src/app.ts
git commit -m "feat(api): /members route for birth years"
```

---

## Task 7: API — accounts POST/PATCH accept projection fields

**Files:**
- Modify: `apps/api/src/routes/accounts.ts`
- Test: `apps/api/src/routes/accounts.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/routes/accounts.test.ts` (it already has `beforeEach(resetDb)`, an `app`, and an `initAndLogin` helper — reuse them; adapt the cookie/app names to match the file):

```ts
test("POST then PATCH round-trips projection assumptions", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });

  const id = crypto.randomUUID();
  const create = await app.handle(new Request("http://localhost/accounts", {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      id, name: "SRS", class: "asset", subtype: "investment", currency: "USD",
      valuationMode: "ledger",
      growthRateBps: 800, accessibleFromAge: 62, earlyWithdrawal: "penalty",
      earlyHaircutBps: 500, illiquid: false, liquidationAge: null,
    }),
  }));
  expect(create.status).toBe(200);

  let list = await (await app.handle(new Request("http://localhost/accounts", { headers: { cookie } }))).json();
  let a = list.find((x: any) => x.id === id);
  expect(a.growthRateBps).toBe(800);
  expect(a.accessibleFromAge).toBe(62);
  expect(a.earlyWithdrawal).toBe("penalty");
  expect(a.earlyHaircutBps).toBe(500);

  const patch = await app.handle(new Request(`http://localhost/accounts/${id}`, {
    method: "PATCH", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ growthRateBps: 250, accessibleFromAge: 55, earlyWithdrawal: "none", illiquid: true, liquidationAge: 70 }),
  }));
  expect(patch.status).toBe(200);

  list = await (await app.handle(new Request("http://localhost/accounts", { headers: { cookie } }))).json();
  a = list.find((x: any) => x.id === id);
  expect(a.growthRateBps).toBe(250);
  expect(a.accessibleFromAge).toBe(55);
  expect(a.earlyWithdrawal).toBe("none");
  expect(a.illiquid).toBe(1);
  expect(a.liquidationAge).toBe(70);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun test src/routes/accounts.test.ts`
Expected: FAIL — assumptions come back as defaults (POST ignores them).

- [ ] **Step 3: Implement**

In `apps/api/src/routes/accounts.ts`:

(a) In the POST handler's `db.insert(accounts).values({...})`, add the new fields (defaulting so existing callers are unaffected):

```ts
          growthRateBps: body.growthRateBps ?? 0,
          accessibleFromAge: body.accessibleFromAge ?? 0,
          earlyWithdrawal: body.earlyWithdrawal === "penalty" ? "penalty" : "none",
          earlyHaircutBps: body.earlyHaircutBps ?? 0,
          illiquid: body.illiquid ? 1 : 0,
          liquidationAge: body.liquidationAge ?? null,
```

(b) Extend the POST `body: t.Object({...})` schema with:

```ts
        growthRateBps: t.Optional(t.Number()),
        accessibleFromAge: t.Optional(t.Number()),
        earlyWithdrawal: t.Optional(t.Union([t.Literal("none"), t.Literal("penalty")])),
        earlyHaircutBps: t.Optional(t.Number()),
        illiquid: t.Optional(t.Boolean()),
        liquidationAge: t.Optional(t.Union([t.Number(), t.Null()])),
```

(c) In the PATCH `/:id` handler, add to the `update` builder:

```ts
      if (body.growthRateBps !== undefined) update.growthRateBps = body.growthRateBps;
      if (body.accessibleFromAge !== undefined) update.accessibleFromAge = body.accessibleFromAge;
      if (body.earlyWithdrawal !== undefined) update.earlyWithdrawal = body.earlyWithdrawal;
      if (body.earlyHaircutBps !== undefined) update.earlyHaircutBps = body.earlyHaircutBps;
      if (body.illiquid !== undefined) update.illiquid = body.illiquid ? 1 : 0;
      if (body.liquidationAge !== undefined) update.liquidationAge = body.liquidationAge;
```

(d) Extend the PATCH `body: t.Object({...})` schema with:

```ts
        growthRateBps: t.Optional(t.Number()),
        accessibleFromAge: t.Optional(t.Number()),
        earlyWithdrawal: t.Optional(t.Union([t.Literal("none"), t.Literal("penalty")])),
        earlyHaircutBps: t.Optional(t.Number()),
        illiquid: t.Optional(t.Boolean()),
        liquidationAge: t.Optional(t.Union([t.Number(), t.Null()])),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && bun test src/routes/accounts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/accounts.ts apps/api/src/routes/accounts.test.ts
git commit -m "feat(api): accounts accept/patch projection assumptions"
```

---

## Task 8: Web — assumption defaults + collections wiring

**Files:**
- Create: `apps/web/src/lib/assumptions.ts`
- Modify: `apps/web/src/lib/collections.ts`

- [ ] **Step 1: Create the defaults helper**

Create `apps/web/src/lib/assumptions.ts`:

```ts
import type { EarlyWithdrawal } from "@uang/shared";

export type Assumptions = {
  growthRateBps: number;
  accessibleFromAge: number;
  earlyWithdrawal: EarlyWithdrawal;
  earlyHaircutBps: number;
  illiquid: boolean;
  liquidationAge: number | null;
};

// Sensible starting points; every field is editable per account afterwards.
export function defaultAssumptions(subtype: string): Assumptions {
  const base: Assumptions = {
    growthRateBps: 0, accessibleFromAge: 0, earlyWithdrawal: "none",
    earlyHaircutBps: 0, illiquid: false, liquidationAge: null,
  };
  switch (subtype) {
    case "investment": return { ...base, growthRateBps: 800 };
    case "property": return { ...base, growthRateBps: 300, illiquid: true };
    default: return base; // cash, bank, loan, credit_card, other
  }
}
```

- [ ] **Step 2: Extend AccountRow handling in collections**

In `apps/web/src/lib/collections.ts`, the `AccountRow` type is inferred from the API, so the six new fields flow in automatically once Task 5 lands. Update the two mutation handlers to send them.

In `onInsert` (the `api.accounts.post({...})` call), add:

```ts
        growthRateBps: m.growthRateBps,
        accessibleFromAge: m.accessibleFromAge,
        earlyWithdrawal: m.earlyWithdrawal,
        earlyHaircutBps: m.earlyHaircutBps,
        illiquid: m.illiquid === 1,
        liquidationAge: m.liquidationAge ?? null,
```

In `onUpdate` (the `api.accounts({ id: m.id }).patch({...})` call), add the same six lines.

> Note: `AccountRow.illiquid` is the DB shape (`0|1`) from GET; the API expects a boolean, hence `m.illiquid === 1`.

- [ ] **Step 3: Add membersCollection**

Append to `apps/web/src/lib/collections.ts`:

```ts
// ---------------------------------------------------------------------------
// membersCollection — household members + birth years
// ---------------------------------------------------------------------------

export type MemberRow = RowOf<typeof api.members.get>;

export const membersCollection = createCollection(
  queryCollectionOptions<MemberRow, Error, ["members"], string>({
    queryKey: ["members"],
    queryFn: async (): Promise<Array<MemberRow>> => {
      const { data, error } = await api.members.get();
      if (error) throw new Error(String(error));
      return Array.isArray(data) ? data : [];
    },
    queryClient,
    getKey: (m) => m.id,
    onUpdate: async ({ transaction }) => {
      const m = transaction.mutations[0]?.modified as MemberRow | undefined;
      if (!m) return;
      const { error } = await api.members({ id: m.id }).patch({ birthYear: m.birthYear ?? null });
      if (error) throw new Error(String(error));
    },
  })
);
```

- [ ] **Step 4: Type-check**

Run: `cd apps/web && bunx tsc -b`
Expected: no type errors. (If `api.members` is missing, the API app type wasn't rebuilt — ensure Task 6 landed and the web app imports the same `App` type.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/assumptions.ts apps/web/src/lib/collections.ts
git commit -m "feat(web): assumption defaults + members collection + send account fields"
```

---

## Task 9: Web — seed assumptions on create + edit dialog on account detail

**Files:**
- Modify: `apps/web/src/components/account-form.tsx`, `apps/web/src/routes/account-detail.tsx`
- Create: `apps/web/src/components/account-assumptions-dialog.tsx`

- [ ] **Step 1: Seed assumptions when creating an account**

In `apps/web/src/components/account-form.tsx`, import the helper:

```ts
import { defaultAssumptions } from "@/lib/assumptions";
```

In `submit`, after computing `currency` and before building `row`, derive the defaults from the chosen subtype:

```ts
    const asm = defaultAssumptions(f.subtype);
```

Add these fields to the `row: AccountRow = {...}` literal (alongside `sortOrder`, `balanceMinor`, etc.):

```ts
      growthRateBps: asm.growthRateBps,
      accessibleFromAge: asm.accessibleFromAge,
      earlyWithdrawal: asm.earlyWithdrawal,
      earlyHaircutBps: asm.earlyHaircutBps,
      illiquid: asm.illiquid ? 1 : 0,
      liquidationAge: asm.liquidationAge,
```

- [ ] **Step 2: Create the assumptions edit dialog**

Ensure the shadcn `switch` component exists (used for `illiquid`); if not, add it:

Run: `cd apps/web && bunx shadcn@latest add switch`

Create `apps/web/src/components/account-assumptions-dialog.tsx`:

```tsx
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { accountsCollection, type AccountRow } from "@/lib/collections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

// bps <-> percent helpers (UI shows percent; storage is basis points).
const toPct = (bps: number) => String(bps / 100);
const fromPct = (s: string) => Math.round((parseFloat(s) || 0) * 100);

export function AccountAssumptionsDialog({ account }: { account: AccountRow }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({
    growthPct: toPct(account.growthRateBps),
    accessibleFromAge: String(account.accessibleFromAge),
    earlyWithdrawal: account.earlyWithdrawal,
    earlyHaircutPct: toPct(account.earlyHaircutBps),
    illiquid: account.illiquid === 1,
    liquidationAge: account.liquidationAge == null ? "" : String(account.liquidationAge),
  });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    accountsCollection.update(account.id, (draft) => {
      draft.growthRateBps = fromPct(f.growthPct);
      draft.accessibleFromAge = parseInt(f.accessibleFromAge, 10) || 0;
      draft.earlyWithdrawal = f.earlyWithdrawal;
      draft.earlyHaircutBps = fromPct(f.earlyHaircutPct);
      draft.illiquid = f.illiquid ? 1 : 0;
      draft.liquidationAge = f.liquidationAge === "" ? null : parseInt(f.liquidationAge, 10);
    });
    await qc.invalidateQueries({ queryKey: ["networth"] });
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>Edit assumptions</DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Projection assumptions</DialogTitle></DialogHeader>
        <form onSubmit={save} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Annual growth %</Label>
              <Input type="number" step="any" value={f.growthPct}
                onChange={(e) => setF((p) => ({ ...p, growthPct: e.target.value }))} />
            </div>
            <div>
              <Label>Accessible from age</Label>
              <Input type="number" value={f.accessibleFromAge}
                onChange={(e) => setF((p) => ({ ...p, accessibleFromAge: e.target.value }))} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Before that age</Label>
              <Select value={f.earlyWithdrawal}
                onValueChange={(v: string | null) => v && setF((p) => ({ ...p, earlyWithdrawal: v as AccountRow["earlyWithdrawal"] }))}>
                <SelectTrigger className="w-full">
                  <SelectValue>{(v: unknown) => (String(v) === "penalty" ? "Withdraw with penalty" : "Locked")}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Locked</SelectItem>
                  <SelectItem value="penalty">Withdraw with penalty</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Early penalty %</Label>
              <Input type="number" step="any" value={f.earlyHaircutPct}
                disabled={f.earlyWithdrawal !== "penalty"}
                onChange={(e) => setF((p) => ({ ...p, earlyHaircutPct: e.target.value }))} />
            </div>
          </div>
          <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
            <Label>Illiquid (exclude from accessible)</Label>
            <Switch checked={f.illiquid} onCheckedChange={(v: boolean) => setF((p) => ({ ...p, illiquid: v }))} />
          </div>
          {f.illiquid && (
            <div>
              <Label>Liquidation age (optional)</Label>
              <Input type="number" value={f.liquidationAge} placeholder="never"
                onChange={(e) => setF((p) => ({ ...p, liquidationAge: e.target.value }))} />
            </div>
          )}
          <DialogFooter><Button type="submit">Save</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 3: Mount the dialog on account detail**

In `apps/web/src/routes/account-detail.tsx`, import the dialog:

```ts
import { AccountAssumptionsDialog } from "@/components/account-assumptions-dialog";
```

Render `<AccountAssumptionsDialog account={account} />` in the account-detail header action area (next to the existing actions; `account` is the already-loaded `AccountRow` for the page — match the variable name used in that file).

- [ ] **Step 4: Verify build + manual check**

Run: `cd apps/web && bunx tsc -b`
Expected: no type errors.

Manual: start the app (`bun run dev` in `apps/api` and `apps/web`), open an account, click **Edit assumptions**, set growth 8% / accessible-from 62 / penalty 5%, save, reload — values persist.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/account-form.tsx apps/web/src/components/account-assumptions-dialog.tsx apps/web/src/routes/account-detail.tsx apps/web/src/components/ui/switch.tsx
git commit -m "feat(web): seed + edit per-account projection assumptions"
```

---

## Task 10: Web — birth years in settings

**Files:**
- Modify: `apps/web/src/routes/settings.tsx`

- [ ] **Step 1: Add a Members section to settings**

In `apps/web/src/routes/settings.tsx`, add imports:

```ts
import { useLiveQuery } from "@tanstack/react-db";
import { membersCollection } from "@/lib/collections";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
```

Add this component in the file and render it within the settings page layout:

```tsx
function MembersSection() {
  const { data: members = [] } = useLiveQuery((q) => q.from({ m: membersCollection }));
  return (
    <section className="rounded-2xl border border-border bg-card p-4">
      <h2 className="mb-3 text-sm font-medium text-muted-foreground">Members</h2>
      <div className="space-y-3">
        {members.map((m) => (
          <div key={m.id} className="flex items-center justify-between gap-3">
            <Label className="flex-1">{m.name}</Label>
            <Input
              type="number"
              className="w-32"
              placeholder="Birth year"
              defaultValue={m.birthYear ?? ""}
              onBlur={(e) => {
                const v = e.target.value === "" ? null : parseInt(e.target.value, 10);
                if (v !== (m.birthYear ?? null)) {
                  membersCollection.update(m.id, (draft) => { draft.birthYear = v; });
                }
              }}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
```

> Confirm the `useLiveQuery` import path matches how other components in this repo read collections live; if the repo uses a different hook (e.g. a wrapper), follow that pattern.

- [ ] **Step 2: Verify build + manual check**

Run: `cd apps/web && bunx tsc -b`
Expected: no type errors.

Manual: open Settings, set a birth year for each member, blur the field, reload — the value persists.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/settings.tsx
git commit -m "feat(web): edit member birth years in settings"
```

---

## Task 11: Web — projection chart + /projections route

**Files:**
- Create: `apps/web/src/components/projection-chart.tsx`, `apps/web/src/routes/projections.tsx`
- Modify: `apps/web/src/router.tsx`, `apps/web/src/routes/dashboard.tsx`

- [ ] **Step 1: Build the chart component**

Create `apps/web/src/components/projection-chart.tsx`:

```tsx
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts";
import { projectNetWorth, milestoneYears, type ProjectionAccount } from "@uang/shared";
import { api } from "@/lib/api";
import { formatMoney } from "@/components/money";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig,
} from "@/components/ui/chart";

type NwAccount = {
  id: string; baseMinor: number; ownerIds: string[];
  growthRateBps: number; accessibleFromAge: number;
  earlyWithdrawal: "none" | "penalty"; earlyHaircutBps: number;
  illiquid: boolean; liquidationAge: number | null;
};
type Member = { id: string; name: string; birthYear: number | null };

const chartConfig = {
  total: { label: "Total", color: "var(--chart-1)" },
  accessible: { label: "Accessible", color: "var(--chart-2)" },
} satisfies ChartConfig;

async function fetchNetWorth(): Promise<{ baseCurrency: string; accounts: NwAccount[] }> {
  const { data, error } = await api.networth.get({ query: {} });
  if (error) throw new Error(String(error));
  return data as unknown as { baseCurrency: string; accounts: NwAccount[] };
}
async function fetchMembers(): Promise<Member[]> {
  const { data, error } = await api.members.get();
  if (error) throw new Error(String(error));
  return (data as unknown as Member[]) ?? [];
}

const MILESTONE_COLORS = ["var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

export function ProjectionChart() {
  const [endAge, setEndAge] = useState(90);
  const nwQ = useQuery({ queryKey: ["networth", "household"], queryFn: fetchNetWorth });
  const membersQ = useQuery({ queryKey: ["members"], queryFn: fetchMembers });

  const base = nwQ.data?.baseCurrency ?? "";
  const thisYear = new Date().getFullYear();

  const { rows, milestones } = useMemo(() => {
    const accounts = nwQ.data?.accounts ?? [];
    const members = membersQ.data ?? [];
    const birthById = new Map(members.map((m) => [m.id, m.birthYear]));

    const projAccounts: ProjectionAccount[] = accounts.map((a) => ({
      baseMinor: a.baseMinor,
      growthRateBps: a.growthRateBps,
      accessibleFromAge: a.accessibleFromAge,
      earlyWithdrawal: a.earlyWithdrawal,
      earlyHaircutBps: a.earlyHaircutBps,
      illiquid: a.illiquid,
      liquidationAge: a.liquidationAge,
      ownerBirthYears: a.ownerIds
        .map((id) => birthById.get(id) ?? null)
        .filter((y): y is number => y != null),
    }));

    // Horizon: until the youngest member reaches endAge (fallback +50 years).
    const birthYears = members.map((m) => m.birthYear).filter((y): y is number => y != null);
    const youngestBirth = birthYears.length ? Math.max(...birthYears) : null;
    const toYear = youngestBirth ? youngestBirth + endAge : thisYear + 50;

    const points = projectNetWorth({ accounts: projAccounts, fromYear: thisYear, toYear: Math.max(toYear, thisYear) });
    const rows = points.map((p) => ({
      year: p.year, total: p.totalBaseMinor, accessible: p.accessibleBaseMinor,
    }));

    const milestones = members
      .filter((m) => m.birthYear != null)
      .flatMap((m) =>
        milestoneYears(m.birthYear as number)
          .filter((ms) => ms.year >= thisYear && ms.year <= (rows.at(-1)?.year ?? thisYear))
          .map((ms, i) => ({ ...ms, name: m.name, color: MILESTONE_COLORS[i % MILESTONE_COLORS.length] })),
      );

    return { rows, milestones };
  }, [nwQ.data, membersQ.data, endAge, thisYear]);

  return (
    <section className="rounded-2xl border border-border bg-card px-4 py-4 shadow-sm md:px-6 md:py-5">
      <div className="mb-3 flex items-center gap-2">
        <Label htmlFor="endAge" className="text-sm text-muted-foreground">Project until age</Label>
        <Input id="endAge" type="number" className="w-20" value={endAge}
          onChange={(e) => setEndAge(parseInt(e.target.value, 10) || 90)} />
      </div>

      {nwQ.isLoading || membersQ.isLoading ? (
        <div className="h-[260px] animate-pulse rounded-xl bg-muted/40" />
      ) : rows.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">No accounts to project.</p>
      ) : (
        <ChartContainer config={chartConfig} className="h-[260px] w-full">
          <LineChart data={rows} margin={{ left: 8, right: 8, top: 8 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="year" tickLine={false} axisLine={false} tickMargin={8} />
            <YAxis hide />
            <ChartTooltip
              content={<ChartTooltipContent
                labelFormatter={(l) => `Year ${l}`}
                formatter={(value, name) => `${name === "total" ? "Total" : "Accessible"}: ${formatMoney(Number(value), base)}`}
              />}
            />
            {milestones.map((ms) => (
              <ReferenceLine key={`${ms.name}-${ms.age}`} x={ms.year} stroke={ms.color}
                strokeDasharray="3 3"
                label={{ value: `${ms.name} ${ms.age}`, position: "top", fontSize: 10 }} />
            ))}
            <Line dataKey="total" type="monotone" stroke="var(--color-total)" strokeWidth={2} dot={false} />
            <Line dataKey="accessible" type="monotone" stroke="var(--color-accessible)" strokeWidth={2} dot={false} />
          </LineChart>
        </ChartContainer>
      )}
    </section>
  );
}
```

> If `api.networth.get` in this repo takes no `query` arg, call `api.networth.get()` (check `net-worth-chart.tsx` / `dashboard.tsx` for the exact call shape). The household view is the default (no `owner`).

- [ ] **Step 2: Create the page**

Create `apps/web/src/routes/projections.tsx`:

```tsx
import { ProjectionChart } from "@/components/projection-chart";

export function ProjectionsPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-6 md:py-10">
      <h1 className="mb-1 text-xl font-semibold">Projections</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        Total vs accessible net worth over time, at your assumed growth rates.
      </p>
      <ProjectionChart />
    </main>
  );
}
```

- [ ] **Step 3: Register the route**

In `apps/web/src/router.tsx`:

Add the import:

```ts
import { ProjectionsPage } from "./routes/projections";
```

Add the route definition (after `settingsRoute`):

```ts
const projectionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projections",
  component: ProjectionsPage,
  beforeLoad: requireInitializedAndAuthed,
});
```

Add `projectionsRoute` to the `rootRoute.addChildren([...])` array.

- [ ] **Step 4: Link from the dashboard**

In `apps/web/src/routes/dashboard.tsx`, add a link to projections in the header/actions area:

```tsx
<Link to="/projections" className="text-sm font-medium text-primary hover:underline">
  Projections →
</Link>
```

(Ensure `import { Link } from "@tanstack/react-router";` is present — it likely already is.)

- [ ] **Step 5: Verify build + manual check**

Run: `cd apps/web && bunx tsc -b`
Expected: no type errors.

Manual: with at least one member birth year set and a couple of accounts with growth/accessibility configured, open `/projections`. Confirm: two lines (total ≥ accessible), accessible jumps up at the owner's 55/62 milestone years, milestone markers render, and changing "Project until age" re-scales the horizon.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/projection-chart.tsx apps/web/src/routes/projections.tsx apps/web/src/router.tsx apps/web/src/routes/dashboard.tsx
git commit -m "feat(web): projected net-worth curve at /projections"
```

---

## Task 12: Full verification + finish the branch

- [ ] **Step 1: Run the full test suite**

Run: `cd packages/shared && bun test` then `cd apps/api && bun test`
Expected: all green (shared engine + API including the new members/accounts/valuation tests).

- [ ] **Step 2: Type-check the web app**

Run: `cd apps/web && bunx tsc -b`
Expected: no errors.

- [ ] **Step 3: End-to-end manual smoke**

Start API + web. Confirm the whole flow: set birth years in Settings → set assumptions on a few accounts (CPF age 55 locked, SRS age 62 penalty 5%, an investment at 8%, property illiquid) → open `/projections` and sanity-check the two curves and milestone markers against expectations.

- [ ] **Step 4: Use the finishing-a-development-branch skill**

Invoke `superpowers:finishing-a-development-branch` to decide how to integrate `slice6-projections` (merge to `main`, matching the existing slice-merge history).

---

## Self-review notes (coverage vs spec)

- Spec §3.1 account columns → Tasks 4, 7. §3.2 member_profiles → Tasks 4, 6, 10. §3.3 goals / §3.4 settings assumptions → **slice 2** (not this plan); `contributionGrowthRateBps` deferred with goals.
- Spec §4 engine (`projectAccount`/`accessibleValue`/`projectNetWorth`/milestones) → Tasks 1–3. Contributions param included now (used by slice 2) to avoid rework.
- Spec §6 UI (chart, account fields, member birth years) → Tasks 9–11.
- **Deviations from spec, intentional for slice-1 scope:**
  - `projectionEndAge` is a **client-side control** (default 90), not persisted to `settings`, to avoid a settings migration this slice. Revisit when `contributionGrowthRateBps` lands in slice 2.
  - The curve is **projection-only** (current year → horizon). Stitching the existing weekly *historical* series onto the left is deferred to a small follow-up (units differ: weekly dates vs yearly points) and is not required for the headline.
- Spec §7 testing → engine + API fully unit-tested (Tasks 1–7); web verified via `tsc` + manual smoke, matching the repo's test surface (no existing web component tests).
