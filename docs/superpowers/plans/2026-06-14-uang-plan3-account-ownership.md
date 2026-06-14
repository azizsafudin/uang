# Uang — Plan 3: Account Ownership & By-Owner Net Worth

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the household see net worth from different vantage points — the whole household or an individual member — by giving every account one or more owners (1 owner = personal, 2+ = shared), with a dashboard toggle that re-points only the headline.

**Architecture:** Add a many-to-many `account_owners` join table with an idempotent boot-time backfill. A small `owners` lib on the API owns all reads/writes of the relation. The `netWorth()` engine gains an `owner` option and the personal/shared rule lives there. Accounts routes expose `ownerIds` on read, accept them on create, and gain a replace-owners endpoint. On the web, an `OwnersField` checkbox list (reused by the create form and the detail editor) and a `NetWorthToggle` drive the new behaviour; the account list stays sourced from the constant household valuation so toggling changes only the hero number.

**Tech Stack:** (unchanged) Bun, ElysiaJS, libSQL/Drizzle, better-auth, TanStack Router, TanStack DB + TanStack Query, shadcn/ui + Tailwind, Eden Treaty. Tests: `bun test` (API), `bun run build` is the gate for web.

> **Scope:** Plan 3 of the build. **In:** `account_owners` table + backfill; `ownerIds` on account create/list; a replace-owners endpoint; the net-worth owner filter; a dashboard view toggle (headline only); an owners picker in the account form; owner display + inline edit on the account detail page. **Deferred:** per-owner *shares* of a shared account (never split); per-account permissions (all members stay equal); applying the owner filter to the future net-worth-over-time graph (later slice, reuses this filter).

> **Money at the JSON boundary:** money stays integer minor units in the DB and `BigInt` in `@uang/shared` math; the API serializes money as JS numbers. Use the existing `toBig`/`fromBig` helpers only at the math edge. This plan does not change money handling.

> **The one invariant (from the spec §4):** for an account with owner set `O`: `|O| == 1` → personal to that member (counts in their individual net worth and the household total); `|O| >= 2` → shared (`shared = |O| >= 2`), excluded from every individual and counted only in the household total. No splitting, no partial attribution.

---

## File Structure

```
apps/api/src/
├── db/
│   ├── schema.ts            # MODIFIED: add accountOwners table (account_owners)
│   └── migrate.ts           # (unchanged) applies ./drizzle migrations
├── drizzle/
│   └── 0001_*.sql           # NEW: generated migration for account_owners (drizzle-kit)
├── lib/
│   ├── owners.ts            # NEW: getOwnersByAccount, getAllOwnerSets, setOwners, backfillOwners, allUsersExist
│   ├── owners.test.ts       # NEW
│   ├── valuation.ts         # MODIFIED: netWorth(opts) gains owner filter; AccountValuation gains ownerIds, shared
│   ├── valuation.test.ts    # MODIFIED: owner-filter + shared-flag tests
│   └── test-helpers.ts      # MODIFIED: resetDb clears account_owners
├── routes/
│   ├── accounts.ts          # MODIFIED: GET returns ownerIds; POST accepts ownerIds (default creator, validate); PATCH /:id/owners
│   ├── accounts.test.ts     # MODIFIED: ownerIds on create/list + PATCH owners cases
│   ├── networth.ts          # MODIFIED: ?owner= query param
│   └── networth.test.ts     # MODIFIED: owner-filter route cases
└── index.ts                 # MODIFIED: call backfillOwners() after runMigrations()

apps/web/src/
├── components/ui/
│   ├── checkbox.tsx         # NEW (shadcn CLI)
│   └── badge.tsx            # NEW (shadcn CLI)
├── lib/
│   ├── use-users.ts         # NEW: useUsers() query hook (shared member list)
│   └── collections.ts       # MODIFIED: AccountRow gains ownerIds
├── components/
│   ├── owners-field.tsx     # NEW: OwnersField checkbox list (reused by form + detail)
│   ├── owners-badge.tsx     # NEW: OwnersBadge (member name, or "Shared" badge with names)
│   ├── net-worth-toggle.tsx # NEW: Household + per-member view toggle
│   └── account-form.tsx     # MODIFIED: Owners field, sends ownerIds
└── routes/
    ├── dashboard.tsx        # MODIFIED: toggle drives headline; rows show owners
    └── account-detail.tsx   # MODIFIED: owners display + inline editor
```

> **Test runner note:** API tests run from the api package: `cd /Users/aziz/Workspace/uang/apps/api && bun test <path>`. The web gate runs from the web package: `cd /Users/aziz/Workspace/uang/apps/web && bun run build`.

---

## Task 1: `account_owners` schema + migration

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/drizzle/0001_*.sql` (generated)

- [ ] **Step 1: Add the table to the Drizzle schema**

In `apps/api/src/db/schema.ts`, change the top import line and append the new table before the `export * from "./auth-schema"` line.

Change line 1 from:

```ts
import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";
```

to:

```ts
import { sqliteTable, text, integer, uniqueIndex, primaryKey, index } from "drizzle-orm/sqlite-core";
```

Then add, immediately above `export * from "./auth-schema";`:

```ts
// Many-to-many: which users own an account. >=1 owner per account.
// 1 owner = personal (counts in that member's net worth); 2+ = shared (household total only).
export const accountOwners = sqliteTable("account_owners", {
  accountId: text("account_id").notNull(), // FK -> accounts.id
  userId: text("user_id").notNull(),       // FK -> user.id
}, (t) => [
  primaryKey({ columns: [t.accountId, t.userId] }),
  index("account_owners_user_id_idx").on(t.userId),
]);
```

- [ ] **Step 2: Generate the migration**

Run: `cd /Users/aziz/Workspace/uang/apps/api && bun run db:generate`
Expected: drizzle-kit prints that it created a new file, e.g. `drizzle/0001_*.sql`, containing `CREATE TABLE \`account_owners\`` with a composite primary key and the `account_owners_user_id_idx` index.

- [ ] **Step 3: Verify the migration file exists and looks right**

Run: `ls apps/api/drizzle && grep -i "account_owners" apps/api/drizzle/0001_*.sql`
Expected: the new `0001_*.sql` is listed and the grep shows the `CREATE TABLE account_owners` + index lines.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle
git commit -m "feat(api): add account_owners join table + migration"
```

---

## Task 2: `owners` lib (reads, writes, backfill, validation)

**Files:**
- Create: `apps/api/src/lib/owners.ts`
- Create: `apps/api/src/lib/owners.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/lib/owners.test.ts`:

```ts
import { expect, test, beforeEach } from "bun:test";
import { resetDb } from "./test-helpers";
import { db } from "../db/client";
import { accounts, accountOwners, user } from "../db/schema";
import { createId, nowEpoch } from "./ids";
import {
  getOwnersByAccount,
  getAllOwnerSets,
  setOwners,
  backfillOwners,
  allUsersExist,
} from "./owners";

beforeEach(resetDb);

async function addUser(id: string) {
  await db.insert(user).values({
    id, name: `U${id}`, email: `${id}@t.com`, emailVerified: true,
    createdAt: new Date(), updatedAt: new Date(),
  } as any);
}

async function addAccount(createdBy: string) {
  const id = createId();
  await db.insert(accounts).values({
    id, name: "A", class: "asset", subtype: "bank", currency: "USD",
    valuationMode: "ledger", isArchived: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy,
  });
  return id;
}

test("setOwners then getOwnersByAccount round-trips and dedupes", async () => {
  await addUser("u1");
  await addUser("u2");
  const a = await addAccount("u1");
  await setOwners(a, ["u1", "u2", "u1"]); // duplicate u1
  const owners = (await getOwnersByAccount(a)).sort();
  expect(owners).toEqual(["u1", "u2"]);
});

test("setOwners replaces the prior owner set", async () => {
  await addUser("u1");
  await addUser("u2");
  const a = await addAccount("u1");
  await setOwners(a, ["u1", "u2"]);
  await setOwners(a, ["u2"]);
  expect(await getOwnersByAccount(a)).toEqual(["u2"]);
});

test("getAllOwnerSets groups owners by account", async () => {
  await addUser("u1");
  await addUser("u2");
  const a = await addAccount("u1");
  const b = await addAccount("u2");
  await setOwners(a, ["u1", "u2"]);
  await setOwners(b, ["u2"]);
  const map = await getAllOwnerSets();
  expect([...(map.get(a) ?? [])].sort()).toEqual(["u1", "u2"]);
  expect(map.get(b)).toEqual(["u2"]);
});

test("backfillOwners assigns created_by to ownerless accounts, is idempotent, no-ops on empty DB", async () => {
  await backfillOwners(); // empty DB: no throw, no rows
  expect((await getAllOwnerSets()).size).toBe(0);

  await addUser("u1");
  const a = await addAccount("u1");
  await backfillOwners();
  expect(await getOwnersByAccount(a)).toEqual(["u1"]);

  // Re-run is idempotent: still exactly one owner.
  await backfillOwners();
  expect(await getOwnersByAccount(a)).toEqual(["u1"]);

  // An account that already has owners is left untouched by backfill.
  await addUser("u2");
  await setOwners(a, ["u2"]);
  await backfillOwners();
  expect(await getOwnersByAccount(a)).toEqual(["u2"]);
});

test("allUsersExist is true only when every id exists and the list is non-empty", async () => {
  await addUser("u1");
  await addUser("u2");
  expect(await allUsersExist([])).toBe(false);
  expect(await allUsersExist(["u1", "u2"])).toBe(true);
  expect(await allUsersExist(["u1", "nope"])).toBe(false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/aziz/Workspace/uang/apps/api && bun test src/lib/owners.test.ts`
Expected: FAIL — `Cannot find module './owners'` (the lib does not exist yet).

- [ ] **Step 3: Implement the lib**

Create `apps/api/src/lib/owners.ts`:

```ts
import { db } from "../db/client";
import { accounts, accountOwners, user } from "../db/schema";
import { eq, inArray } from "drizzle-orm";

// All user ids that own a single account.
export async function getOwnersByAccount(accountId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: accountOwners.userId })
    .from(accountOwners)
    .where(eq(accountOwners.accountId, accountId));
  return rows.map((r) => r.userId);
}

// accountId -> [userId, ...] for every account that has owners. One query.
export async function getAllOwnerSets(): Promise<Map<string, string[]>> {
  const rows = await db.select().from(accountOwners);
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const arr = map.get(r.accountId) ?? [];
    arr.push(r.userId);
    map.set(r.accountId, arr);
  }
  return map;
}

// Replace an account's owner set wholesale. Dedupes; empty list clears owners.
export async function setOwners(accountId: string, userIds: string[]): Promise<void> {
  await db.delete(accountOwners).where(eq(accountOwners.accountId, accountId));
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return;
  await db.insert(accountOwners).values(unique.map((userId) => ({ accountId, userId })));
}

// One-time, idempotent: give every ownerless account its creator as sole owner.
// Safe on an empty DB and safe to run on every boot.
export async function backfillOwners(): Promise<void> {
  const accts = await db
    .select({ id: accounts.id, createdBy: accounts.createdBy })
    .from(accounts);
  if (accts.length === 0) return;
  const existing = await getAllOwnerSets();
  const missing = accts.filter((a) => !existing.has(a.id));
  if (missing.length === 0) return;
  await db.insert(accountOwners).values(missing.map((a) => ({ accountId: a.id, userId: a.createdBy })));
}

// True only when the list is non-empty and every (deduped) id is an existing user.
export async function allUsersExist(ids: string[]): Promise<boolean> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return false;
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .where(inArray(user.id, unique));
  return rows.length === unique.length;
}
```

- [ ] **Step 4: Update resetDb to clear the new table**

In `apps/api/src/lib/test-helpers.ts`, add `accountOwners` to the schema import and delete it first in `resetDb` (before `accounts`).

Change the import (line 6) from:

```ts
import { settings, user, accounts, entries, fxRates } from "../db/schema";
```

to:

```ts
import { settings, user, accounts, accountOwners, entries, fxRates } from "../db/schema";
```

Then in `resetDb`, add the delete as the first table clear (right after `await runMigrations();`):

```ts
  await db.delete(accountOwners);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd /Users/aziz/Workspace/uang/apps/api && bun test src/lib/owners.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/owners.ts apps/api/src/lib/owners.test.ts apps/api/src/lib/test-helpers.ts
git commit -m "feat(api): owners lib (read/write/backfill/validate) + clear table in resetDb"
```

---

## Task 3: Run backfill on API boot

**Files:**
- Modify: `apps/api/src/index.ts:14`

- [ ] **Step 1: Wire backfill after migrations**

In `apps/api/src/index.ts`, add the import near the top (next to the existing `runMigrations` import) and call it right after `await runMigrations();`.

Change line 1 from:

```ts
import { runMigrations } from "./db/migrate";
```

to:

```ts
import { runMigrations } from "./db/migrate";
import { backfillOwners } from "./lib/owners";
```

Change line 14 from:

```ts
await runMigrations();
```

to:

```ts
await runMigrations();
await backfillOwners(); // idempotent: give pre-ownership accounts their creator as sole owner
```

- [ ] **Step 2: Verify the API still boots and existing tests pass**

Run: `cd /Users/aziz/Workspace/uang/apps/api && bun test`
Expected: PASS — all existing API tests still green (the new boot call is covered by the owners unit tests; this is a smoke check that nothing imports break).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/index.ts
git commit -m "feat(api): backfill account owners on boot"
```

---

## Task 4: Net-worth owner filter + per-account `ownerIds`/`shared`

**Files:**
- Modify: `apps/api/src/lib/valuation.ts`
- Modify: `apps/api/src/lib/valuation.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/lib/valuation.test.ts`. First extend the imports at the top — change line 4:

```ts
import { settings, accounts, entries, fxRates } from "../db/schema";
```

to:

```ts
import { settings, accounts, entries, fxRates, accountOwners } from "../db/schema";
```

Then add this helper after the existing `addEntry` helper (after line 23):

```ts
async function setOwnersDirect(accountId: string, userIds: string[]) {
  for (const userId of userIds) {
    await db.insert(accountOwners).values({ accountId, userId });
  }
}
```

Then append these tests at the end of the file:

```ts
test("netWorth tags each account with ownerIds and shared (|O|>=2)", async () => {
  await seedBase("USD");
  const personal = await addAccount({ name: "Solo", cls: "asset", currency: "USD" });
  await addEntry(personal, 10000, "2026-01-01");
  await setOwnersDirect(personal, ["u1"]);
  const joint = await addAccount({ name: "Joint", cls: "asset", currency: "USD" });
  await addEntry(joint, 20000, "2026-01-01");
  await setOwnersDirect(joint, ["u1", "u2"]);

  const nw = await netWorth();
  const solo = nw.accounts.find((a) => a.name === "Solo")!;
  const both = nw.accounts.find((a) => a.name === "Joint")!;
  expect(solo.ownerIds.sort()).toEqual(["u1"]);
  expect(solo.shared).toBe(false);
  expect(both.ownerIds.sort()).toEqual(["u1", "u2"]);
  expect(both.shared).toBe(true);
});

test("netWorth household total includes personal + shared accounts", async () => {
  await seedBase("USD");
  const solo = await addAccount({ name: "Solo", cls: "asset", currency: "USD" });
  await addEntry(solo, 10000, "2026-01-01");
  await setOwnersDirect(solo, ["u1"]);
  const joint = await addAccount({ name: "Joint", cls: "asset", currency: "USD" });
  await addEntry(joint, 20000, "2026-01-01");
  await setOwnersDirect(joint, ["u1", "u2"]);

  const nw = await netWorth({ owner: "household" });
  expect(nw.totalBaseMinor).toBe(30000);
  expect(nw.accounts.length).toBe(2);
});

test("netWorth for a member includes only their sole-owned accounts, excludes shared + others", async () => {
  await seedBase("USD");
  const mine = await addAccount({ name: "Mine", cls: "asset", currency: "USD" });
  await addEntry(mine, 10000, "2026-01-01");
  await setOwnersDirect(mine, ["u1"]);
  const joint = await addAccount({ name: "Joint", cls: "asset", currency: "USD" });
  await addEntry(joint, 20000, "2026-01-01");
  await setOwnersDirect(joint, ["u1", "u2"]);
  const theirs = await addAccount({ name: "Theirs", cls: "asset", currency: "USD" });
  await addEntry(theirs, 40000, "2026-01-01");
  await setOwnersDirect(theirs, ["u2"]);

  const nw = await netWorth({ owner: "u1" });
  expect(nw.totalBaseMinor).toBe(10000); // only "Mine"
  expect(nw.accounts.map((a) => a.name)).toEqual(["Mine"]);
});

test("netWorth still supports asOf via the options object", async () => {
  await seedBase("USD");
  const a = await addAccount({ name: "Savings", cls: "asset", currency: "USD" });
  await addEntry(a, 50000, "2026-03-01");
  await setOwnersDirect(a, ["u1"]);
  expect((await netWorth({ asOf: "2026-02-01" })).totalBaseMinor).toBe(0);
  expect((await netWorth({ asOf: "2026-03-01" })).totalBaseMinor).toBe(50000);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/aziz/Workspace/uang/apps/api && bun test src/lib/valuation.test.ts`
Expected: FAIL — the new tests fail because `netWorth` does not accept an options object and `AccountValuation` has no `ownerIds`/`shared` (type/runtime errors on `solo.ownerIds`, `netWorth({ owner })`).

- [ ] **Step 3: Implement the owner filter**

In `apps/api/src/lib/valuation.ts`:

Add the owners import after the existing imports (after line 4):

```ts
import { getAllOwnerSets } from "./owners";
```

Extend the `AccountValuation` type (replace lines 30-33) with:

```ts
export type AccountValuation = {
  id: string; name: string; class: string; subtype: string; currency: string;
  balanceMinor: number; baseMinor: number; missingRate: boolean;
  ownerIds: string[]; shared: boolean;
};

export type NetWorthOpts = { asOf?: string; owner?: string };
```

Replace the whole `netWorth` function (lines 41-69) with:

```ts
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
    // `household` (or absent) sees everything.
    if (owner && owner !== "household") {
      const personalToOwner = ownerIds.length === 1 && ownerIds[0] === owner;
      if (!personalToOwner) continue;
    }

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
      balanceMinor, baseMinor, missingRate, ownerIds, shared,
    });
  }
  return { baseCurrency: base, totalBaseMinor: fromBig(total), accounts: out };
}
```

- [ ] **Step 4: Run to verify all valuation tests pass**

Run: `cd /Users/aziz/Workspace/uang/apps/api && bun test src/lib/valuation.test.ts`
Expected: PASS — the original 3 tests (no owners → `ownerIds: []`, `shared: false`, all included) plus the 4 new ones.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/valuation.ts apps/api/src/lib/valuation.test.ts
git commit -m "feat(api): netWorth owner filter + ownerIds/shared per account"
```

---

## Task 5: Accounts routes — `ownerIds` on read/create + replace-owners endpoint

**Files:**
- Modify: `apps/api/src/routes/accounts.ts`
- Modify: `apps/api/src/routes/accounts.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/routes/accounts.test.ts`. First, add a helper for reading the admin's user id and a couple of cases. Add these tests at the end of the file:

```ts
import { db } from "../db/client";
import { user } from "../db/schema";

async function firstUserId(): Promise<string> {
  const rows = await db.select({ id: user.id }).from(user);
  return rows[0]!.id;
}

test("create defaults owner to the creator and GET returns ownerIds", async () => {
  const app = makeApp(accountsRoutes);
  const { cookie } = await initAndLogin({ app });
  const me = await firstUserId();

  const create = await app.handle(new Request("http://localhost/accounts", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Solo", class: "asset", subtype: "bank", currency: "USD" }),
  }));
  expect(create.status).toBe(200);

  const list = await (await app.handle(
    new Request("http://localhost/accounts", { headers: { cookie } }),
  )).json();
  expect(list[0].ownerIds).toEqual([me]);
});

test("create accepts explicit ownerIds", async () => {
  const app = makeApp(accountsRoutes);
  const { cookie } = await initAndLogin({ app });
  const me = await firstUserId();

  const create = await app.handle(new Request("http://localhost/accounts", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Joint", class: "asset", subtype: "bank", currency: "USD", ownerIds: [me] }),
  }));
  expect(create.status).toBe(200);
  const list = await (await app.handle(
    new Request("http://localhost/accounts", { headers: { cookie } }),
  )).json();
  expect(list.find((a: any) => a.name === "Joint").ownerIds).toEqual([me]);
});

test("create rejects invalid owner ids with 422", async () => {
  const app = makeApp(accountsRoutes);
  const { cookie } = await initAndLogin({ app });

  const res = await app.handle(new Request("http://localhost/accounts", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Bad", class: "asset", subtype: "bank", currency: "USD", ownerIds: ["ghost"] }),
  }));
  expect(res.status).toBe(422);
});

test("PATCH /:id/owners replaces the owner set", async () => {
  const app = makeApp(accountsRoutes);
  const { cookie } = await initAndLogin({ app });
  const me = await firstUserId();

  const { id } = await (await app.handle(new Request("http://localhost/accounts", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Solo", class: "asset", subtype: "bank", currency: "USD" }),
  }))).json();

  const patch = await app.handle(new Request(`http://localhost/accounts/${id}/owners`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ ownerIds: [me] }),
  }));
  expect(patch.status).toBe(200);

  const list = await (await app.handle(
    new Request("http://localhost/accounts", { headers: { cookie } }),
  )).json();
  expect(list.find((a: any) => a.id === id).ownerIds).toEqual([me]);
});

test("PATCH /:id/owners rejects empty list (422)", async () => {
  const app = makeApp(accountsRoutes);
  const { cookie } = await initAndLogin({ app });
  const { id } = await (await app.handle(new Request("http://localhost/accounts", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Solo", class: "asset", subtype: "bank", currency: "USD" }),
  }))).json();

  const res = await app.handle(new Request(`http://localhost/accounts/${id}/owners`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ ownerIds: [] }),
  }));
  expect(res.status).toBe(422);
});

test("PATCH /:id/owners rejects invalid owner ids (422)", async () => {
  const app = makeApp(accountsRoutes);
  const { cookie } = await initAndLogin({ app });
  const { id } = await (await app.handle(new Request("http://localhost/accounts", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Solo", class: "asset", subtype: "bank", currency: "USD" }),
  }))).json();

  const res = await app.handle(new Request(`http://localhost/accounts/${id}/owners`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ ownerIds: ["ghost"] }),
  }));
  expect(res.status).toBe(422);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/aziz/Workspace/uang/apps/api && bun test src/routes/accounts.test.ts`
Expected: FAIL — `ownerIds` is undefined on listed accounts and `PATCH /:id/owners` returns 404 (route not defined).

- [ ] **Step 3: Implement the route changes**

Rewrite `apps/api/src/routes/accounts.ts` to: attach `ownerIds` on GET, default+validate `ownerIds` on POST, and add the `PATCH /:id/owners` endpoint. Full file:

```ts
import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { accounts, entries } from "../db/schema";
import { eq } from "drizzle-orm";
import { authGuard } from "../lib/auth-guard";
import { createId, nowEpoch } from "../lib/ids";
import { accountBalanceMinor } from "../lib/valuation";
import { getAllOwnerSets, setOwners, allUsersExist } from "../lib/owners";

export const accountsRoutes = new Elysia({ prefix: "/accounts" })
  .use(authGuard)
  .get("/", async () => {
    const rows = await db.select().from(accounts).orderBy(accounts.sortOrder);
    const ownerSets = await getAllOwnerSets();
    return Promise.all(
      rows.map(async (a) => ({
        ...a,
        balanceMinor: await accountBalanceMinor(a.id),
        ownerIds: ownerSets.get(a.id) ?? [],
      })),
    );
  })
  .post(
    "/",
    async ({ body, userId, set }: any) => {
      if ((body.valuationMode ?? "ledger") !== "ledger") {
        set.status = 400;
        return { error: "holdings_not_supported_in_v2" };
      }
      // Default owners to the creator; otherwise every id must be an existing user.
      const ownerIds: string[] =
        Array.isArray(body.ownerIds) && body.ownerIds.length > 0 ? body.ownerIds : [userId!];
      if (!(await allUsersExist(ownerIds))) {
        set.status = 422;
        return { error: "invalid_owner_ids" };
      }

      const id = createId();
      await db.insert(accounts).values({
        id,
        name: body.name,
        class: body.class,
        subtype: body.subtype,
        currency: body.currency.toUpperCase(),
        valuationMode: "ledger",
        institution: body.institution ?? null,
        isArchived: 0,
        sortOrder: body.sortOrder ?? 0,
        createdAt: nowEpoch(),
        createdBy: userId!,
      });
      await setOwners(id, ownerIds);
      if (typeof body.openingBalanceMinor === "number" && body.openingBalanceMinor !== 0) {
        const today = new Date(nowEpoch() * 1000).toISOString().slice(0, 10);
        await db.insert(entries).values({
          id: createId(),
          accountId: id,
          date: body.openingDate ?? today,
          amountMinor: body.openingBalanceMinor,
          kind: "opening",
          createdAt: nowEpoch(),
          createdBy: userId!,
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
        ownerIds: t.Optional(t.Array(t.String())),
      }),
    },
  )
  .patch(
    "/:id/owners",
    async ({ params, body, set }: any) => {
      if (!Array.isArray(body.ownerIds) || body.ownerIds.length === 0 || !(await allUsersExist(body.ownerIds))) {
        set.status = 422;
        return { error: "invalid_owner_ids" };
      }
      await setOwners(params.id, body.ownerIds);
      return { ok: true };
    },
    {
      body: t.Object({ ownerIds: t.Array(t.String()) }),
    },
  )
  .patch(
    "/:id",
    async ({ params, body }: any) => {
      const update: Record<string, unknown> = {};
      if (body.name !== undefined) update.name = body.name;
      if (body.institution !== undefined) update.institution = body.institution;
      if (body.sortOrder !== undefined) update.sortOrder = body.sortOrder;
      if (body.isArchived !== undefined) update.isArchived = body.isArchived ? 1 : 0;
      await db.update(accounts).set(update).where(eq(accounts.id, params.id));
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

> **Note:** `PATCH /:id/owners` is declared **before** `PATCH /:id` so the more specific route matches first.

- [ ] **Step 4: Run to verify the tests pass**

Run: `cd /Users/aziz/Workspace/uang/apps/api && bun test src/routes/accounts.test.ts`
Expected: PASS — original 3 tests plus the 6 new ones.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/accounts.ts apps/api/src/routes/accounts.test.ts
git commit -m "feat(api): accounts ownerIds on read/create + PATCH /:id/owners"
```

---

## Task 6: Net-worth route — `?owner=` query param

**Files:**
- Modify: `apps/api/src/routes/networth.ts`
- Modify: `apps/api/src/routes/networth.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/routes/networth.test.ts`. First extend the imports — change line 5:

```ts
import { accounts, entries } from "../db/schema";
```

to:

```ts
import { accounts, entries, accountOwners } from "../db/schema";
```

Then add this helper after `seedAccount` (after line 44):

```ts
async function ownAccount(accountId: string, userIds: string[]) {
  for (const userId of userIds) {
    await db.insert(accountOwners).values({ accountId, userId });
  }
}
```

Then append these tests:

```ts
test("GET /networth?owner=<member> returns only that member's sole-owned accounts", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });

  const mine = await seedAccount({ name: "Mine", cls: "asset", currency: "USD", amountMinor: 10000, date: "2026-01-01", userId: "u1" });
  await ownAccount(mine, ["u1"]);
  const joint = await seedAccount({ name: "Joint", cls: "asset", currency: "USD", amountMinor: 20000, date: "2026-01-01", userId: "u1" });
  await ownAccount(joint, ["u1", "u2"]);

  const res = await app.handle(new Request("http://localhost/networth?owner=u1", { headers: { cookie } }));
  expect(res.status).toBe(200);
  const nw = await res.json();
  expect(nw.totalBaseMinor).toBe(10000);
  expect(nw.accounts.map((a: any) => a.name)).toEqual(["Mine"]);
});

test("GET /networth?owner=household (and default) includes shared accounts", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });

  const mine = await seedAccount({ name: "Mine", cls: "asset", currency: "USD", amountMinor: 10000, date: "2026-01-01", userId: "u1" });
  await ownAccount(mine, ["u1"]);
  const joint = await seedAccount({ name: "Joint", cls: "asset", currency: "USD", amountMinor: 20000, date: "2026-01-01", userId: "u1" });
  await ownAccount(joint, ["u1", "u2"]);

  const res = await app.handle(new Request("http://localhost/networth?owner=household", { headers: { cookie } }));
  const nw = await res.json();
  expect(nw.totalBaseMinor).toBe(30000);
  const jothe = nw.accounts.find((a: any) => a.name === "Joint");
  expect(jothe.shared).toBe(true);
  expect(jothe.ownerIds.sort()).toEqual(["u1", "u2"]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/aziz/Workspace/uang/apps/api && bun test src/routes/networth.test.ts`
Expected: FAIL — the route ignores `owner`, so the member query still returns all accounts (`30000`, two accounts).

- [ ] **Step 3: Implement the route change**

Rewrite `apps/api/src/routes/networth.ts`:

```ts
import { Elysia, t } from "elysia";
import { authGuard } from "../lib/auth-guard";
import { netWorth } from "../lib/valuation";

export const networthRoutes = new Elysia()
  .use(authGuard)
  .get("/networth", async ({ query }) => netWorth({ asOf: query.asOf, owner: query.owner }), {
    query: t.Object({
      asOf: t.Optional(t.String()),
      owner: t.Optional(t.String()),
    }),
  });
```

- [ ] **Step 4: Run to verify the tests pass**

Run: `cd /Users/aziz/Workspace/uang/apps/api && bun test src/routes/networth.test.ts`
Expected: PASS — original 3 tests (the `asOf` and 401 cases still hold) plus the 2 new owner cases.

- [ ] **Step 5: Run the full API suite**

Run: `cd /Users/aziz/Workspace/uang/apps/api && bun test`
Expected: PASS — entire API test suite green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/networth.ts apps/api/src/routes/networth.test.ts
git commit -m "feat(api): /networth owner filter query param"
```

---

## Task 7: Web — install shadcn components, members hook, collection type

**Files:**
- Create: `apps/web/src/components/ui/checkbox.tsx` (via CLI)
- Create: `apps/web/src/components/ui/badge.tsx` (via CLI)
- Create: `apps/web/src/lib/use-users.ts`
- Modify: `apps/web/src/lib/collections.ts:14-27` (AccountRow)

- [ ] **Step 1: Add the shadcn components via the CLI**

Per project convention (always use the shadcn CLI), run from the web package:

Run: `cd /Users/aziz/Workspace/uang/apps/web && bunx shadcn@latest add checkbox badge`
Expected: creates `src/components/ui/checkbox.tsx` and `src/components/ui/badge.tsx`. If the CLI prompts about overwrite, decline overwriting unrelated files.

- [ ] **Step 2: Verify the files were created**

Run: `ls apps/web/src/components/ui/`
Expected: `badge.tsx` and `checkbox.tsx` now appear alongside the existing components.

- [ ] **Step 3: Create the shared members hook**

Create `apps/web/src/lib/use-users.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export type Member = { id: string; email: string; name: string; isAdmin: boolean };

// Household members. Shared by the owners picker, owner badges, and the net-worth toggle.
export function useUsers() {
  return useQuery({
    queryKey: ["users"],
    queryFn: async (): Promise<Member[]> => {
      const { data, error } = await api.users.get();
      if (error) throw new Error(String(error));
      return (data as unknown as Member[]) ?? [];
    },
  });
}
```

- [ ] **Step 4: Add `ownerIds` to the AccountRow type**

In `apps/web/src/lib/collections.ts`, add `ownerIds` to `AccountRow` (after the `createdBy` field, around line 26):

```ts
  createdBy: string;
  ownerIds: string[];
```

> The `onInsert` handler strips only `id`, `balanceMinor`, `createdAt`, `createdBy`; `ownerIds` therefore flows through to `api.accounts.post(...)` as part of the create body, which the API now accepts.

- [ ] **Step 5: Verify the web build still compiles**

Run: `cd /Users/aziz/Workspace/uang/apps/web && bun run build`
Expected: PASS (type-check + build succeed; nothing references the new type incorrectly yet).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/ui/checkbox.tsx apps/web/src/components/ui/badge.tsx apps/web/src/lib/use-users.ts apps/web/src/lib/collections.ts apps/web/components.json
git commit -m "feat(web): add checkbox+badge (shadcn), useUsers hook, ownerIds on AccountRow"
```

---

## Task 8: Web — `OwnersField` + `OwnersBadge` components

**Files:**
- Create: `apps/web/src/components/owners-field.tsx`
- Create: `apps/web/src/components/owners-badge.tsx`

- [ ] **Step 1: Create the owners picker**

Create `apps/web/src/components/owners-field.tsx`:

```tsx
import { useUsers } from "@/lib/use-users";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

// Checkbox list of household members. At least one should be selected (the
// caller enforces non-empty before submitting). Selecting 2+ marks the account shared.
export function OwnersField({
  value,
  onChange,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const { data: users } = useUsers();
  const toggle = (id: string, checked: boolean) =>
    onChange(checked ? [...value, id] : value.filter((v) => v !== id));

  return (
    <div className="space-y-1.5">
      {(users ?? []).map((u) => (
        <Label
          key={u.id}
          className="flex cursor-pointer items-center gap-2 font-normal"
        >
          <Checkbox
            checked={value.includes(u.id)}
            onCheckedChange={(c) => toggle(u.id, c === true)}
          />
          {u.name}
        </Label>
      ))}
      {value.length >= 2 && (
        <p className="text-xs text-muted-foreground">
          Shared — counts only toward the household total.
        </p>
      )}
    </div>
  );
}
```

> **base-ui note:** the shadcn `Checkbox` exposes `onCheckedChange(checked)` where `checked` may be a boolean. `c === true` normalises it. If the generated component instead emits `(checked: boolean)` directly, the comparison still holds.

- [ ] **Step 2: Create the owners badge**

Create `apps/web/src/components/owners-badge.tsx`:

```tsx
import { useUsers } from "@/lib/use-users";
import { Badge } from "@/components/ui/badge";

// Renders who owns an account: a plain member name for personal accounts,
// or a "Shared" badge (with owner names) when 2+ own it.
export function OwnersBadge({ ownerIds }: { ownerIds: string[] }) {
  const { data: users } = useUsers();
  const names = ownerIds.map((id) => users?.find((u) => u.id === id)?.name ?? "…");

  if (ownerIds.length >= 2) {
    return (
      <Badge variant="secondary" className="font-normal">
        Shared · {names.join(", ")}
      </Badge>
    );
  }
  return (
    <span className="text-xs text-muted-foreground">{names[0] ?? "Unowned"}</span>
  );
}
```

- [ ] **Step 3: Verify the build compiles**

Run: `cd /Users/aziz/Workspace/uang/apps/web && bun run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/owners-field.tsx apps/web/src/components/owners-badge.tsx
git commit -m "feat(web): OwnersField picker + OwnersBadge"
```

---

## Task 9: Web — Owners field in the create form

**Files:**
- Modify: `apps/web/src/components/account-form.tsx`

- [ ] **Step 1: Wire owners into the form**

In `apps/web/src/components/account-form.tsx`:

Add imports (after the existing imports at the top, alongside the other component imports):

```ts
import { useSession } from "@/lib/auth";
import { OwnersField } from "@/components/owners-field";
import { Label } from "@/components/ui/label";
```

> `Label` is already imported in this file — keep a single import; do not duplicate. Only add `useSession` and `OwnersField`.

Add the session lookup and an `owners` state next to the existing `f`/`open` state (after line 35, the `const set = ...` line):

```ts
  const { data: session } = useSession();
  const meId = session?.user?.id;
  const [owners, setOwners] = useState<string[]>([]);
```

Seed the current user as the default owner when the dialog opens. Modify the `Dialog`'s `onOpenChange` (line 60) from:

```tsx
    <Dialog open={open} onOpenChange={(v) => setOpen(v)}>
```

to:

```tsx
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v && meId && owners.length === 0) setOwners([meId]);
      }}
    >
```

Add `ownerIds` to the create body — in `submit`, after the `currency` line inside the `body` object (line 42-47), include owners. Replace the `body` construction with:

```ts
    const body: Record<string, unknown> = {
      name: f.name,
      class: f.class,
      subtype: f.subtype,
      currency,
      ownerIds: owners.length > 0 ? owners : meId ? [meId] : [],
    };
```

Add the Owners field to the form UI — insert this block just before the `<DialogFooter>` (after the Opening date `<div>`, around line 143):

```tsx
          <div>
            <Label>Owners</Label>
            <OwnersField value={owners} onChange={setOwners} />
          </div>
```

- [ ] **Step 2: Build to verify it compiles**

Run: `cd /Users/aziz/Workspace/uang/apps/web && bun run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/account-form.tsx
git commit -m "feat(web): owners picker in the create-account form"
```

---

## Task 10: Web — dashboard view toggle + owners on rows

**Files:**
- Create: `apps/web/src/components/net-worth-toggle.tsx`
- Modify: `apps/web/src/routes/dashboard.tsx`

- [ ] **Step 1: Create the toggle component**

Create `apps/web/src/components/net-worth-toggle.tsx`:

```tsx
import { useUsers } from "@/lib/use-users";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// "Household" plus one option per member. Controls only the headline selection.
export function NetWorthToggle({
  value,
  onChange,
}: {
  value: string; // "household" | userId
  onChange: (v: string) => void;
}) {
  const { data: users } = useUsers();
  const options = [
    { id: "household", label: "Household" },
    ...(users ?? []).map((u) => ({ id: u.id, label: u.name })),
  ];

  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <Button
          key={o.id}
          size="sm"
          variant={value === o.id ? "default" : "outline"}
          onClick={() => onChange(o.id)}
          className={cn(value === o.id && "pointer-events-none")}
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Rewire the dashboard**

In `apps/web/src/routes/dashboard.tsx`, make three changes.

(a) Update imports — add `useState`, the toggle, the owners badge:

Change the React import region at the top to include:

```ts
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
```

and add with the other component imports:

```ts
import { NetWorthToggle } from "@/components/net-worth-toggle";
import { OwnersBadge } from "@/components/owners-badge";
```

(b) Replace `fetchNw` and the component's data wiring. Replace the `fetchNw` function (lines 27-31) with an owner-parameterized fetcher:

```ts
async function fetchNw(owner: string): Promise<NetWorth> {
  const { data, error } = await api.networth.get({ query: { owner } });
  if (error) throw new Error(String(error));
  return data as unknown as NetWorth;
}
```

Then in `DashboardPage`, replace the single `useQuery` (lines 40-43) with an `owner` state plus two queries — one constant household query for the account list/groups, one for the toggled headline:

```ts
  const nav = useNavigate();
  const [owner, setOwner] = useState("household");

  // The account list + group totals always reflect the whole household, so the
  // list never changes when you toggle the headline.
  const { data: listData, isLoading } = useQuery({
    queryKey: ["networth", "household"],
    queryFn: () => fetchNw("household"),
  });

  // The headline follows the toggle. (owner === "household" dedupes with the list query.)
  const { data: headline } = useQuery({
    queryKey: ["networth", owner],
    queryFn: () => fetchNw(owner),
  });
```

Update the derived values below (lines 45-50) to read from `listData`:

```ts
  const base = listData?.baseCurrency ?? "";
  const accounts = listData?.accounts ?? [];
  const groupTotal = (cls: string) =>
    accounts
      .filter((a) => a.class === cls && !a.missingRate)
      .reduce((sum, a) => sum + a.baseMinor, 0);
```

(c) Render the toggle above the hero and the headline from `headline`. Replace the hero `<section>` (lines 76-86) with:

```tsx
      <div className="mb-4">
        <NetWorthToggle value={owner} onChange={setOwner} />
      </div>

      {/* Hero: net worth for the selected vantage point, minted in Fraunces. */}
      <section className="rounded-2xl border border-border bg-card px-6 py-7 shadow-sm md:px-8 md:py-9">
        <Eyebrow>
          Net worth · {owner === "household" ? "household" : "personal"} · as of today
        </Eyebrow>
        <p
          className={cn(
            "mt-3 font-heading text-5xl tracking-tight tabular-nums md:text-6xl",
            headline && headline.totalBaseMinor < 0 && "text-destructive",
          )}
        >
          {!headline ? "—" : formatMoney(headline.totalBaseMinor, headline.baseCurrency)}
        </p>
      </section>
```

(d) Add the owner badge to each account row. Inside the row `<Link>`, in the left `<div className="min-w-0">` block, after the existing subtype/currency `<p>` (around line 125), add:

```tsx
                        <div className="mt-1">
                          <OwnersBadge ownerIds={a.ownerIds} />
                        </div>
```

> `a.ownerIds` is present because the net-worth response now carries it (Task 4). The `NetWorth` type in this file already lists the account fields — extend it: in the `type NetWorth` declaration (lines 12-25), add `ownerIds: string[];` and `shared: boolean;` to the `accounts` array element type.

- [ ] **Step 3: Build to verify it compiles**

Run: `cd /Users/aziz/Workspace/uang/apps/web && bun run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/net-worth-toggle.tsx apps/web/src/routes/dashboard.tsx
git commit -m "feat(web): dashboard view toggle (headline) + owners on account rows"
```

---

## Task 11: Web — owners display + inline editor on account detail

**Files:**
- Modify: `apps/web/src/routes/account-detail.tsx`

- [ ] **Step 1: Add owners display + editor**

In `apps/web/src/routes/account-detail.tsx`:

(a) Add imports — `useState`, the api client, the field + badge:

```ts
import { useState } from "react";
import { api } from "@/lib/api";
import { OwnersField } from "@/components/owners-field";
import { OwnersBadge } from "@/components/owners-badge";
```

(b) Add editor state inside `AccountDetailPage` (after the `account` lookup, around line 29):

```ts
  const [editingOwners, setEditingOwners] = useState(false);
  const [draftOwners, setDraftOwners] = useState<string[]>([]);
```

(c) Add a save handler next to `delEntry` (after line 44):

```ts
  async function saveOwners() {
    if (draftOwners.length === 0) return; // at least one owner required
    await api.accounts({ id }).owners.patch({ ownerIds: draftOwners });
    await qc.invalidateQueries({ queryKey: ["accounts"] });
    await qc.invalidateQueries({ queryKey: ["networth"] });
    setEditingOwners(false);
  }
```

(d) Render owners under the header. Insert this block right after the closing `</header>` (around line 68), before the `<div className="mt-5 ...">` actions block:

```tsx
      <section className="mt-4">
        {!editingOwners ? (
          <div className="flex items-center gap-3">
            <OwnersBadge ownerIds={account.ownerIds} />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraftOwners(account!.ownerIds);
                setEditingOwners(true);
              }}
            >
              Edit owners
            </Button>
          </div>
        ) : (
          <div className="max-w-xs space-y-3 rounded-xl border border-border bg-card p-4">
            <Eyebrow>Owners</Eyebrow>
            <OwnersField value={draftOwners} onChange={setDraftOwners} />
            <div className="flex gap-2">
              <Button size="sm" onClick={saveOwners} disabled={draftOwners.length === 0}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditingOwners(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </section>
```

> `account.ownerIds` is present because the accounts collection now carries it (`GET /accounts` returns `ownerIds`, Task 5; `AccountRow.ownerIds`, Task 7). The non-null `account!` in the click handler is safe — the early return above guarantees `account` is defined past line 39.

- [ ] **Step 2: Build to verify it compiles**

Run: `cd /Users/aziz/Workspace/uang/apps/web && bun run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/account-detail.tsx
git commit -m "feat(web): owners display + inline editor on account detail"
```

---

## Task 12: Full verification + manual E2E

**Files:** none (verification only)

- [ ] **Step 1: Run the entire API test suite**

Run: `cd /Users/aziz/Workspace/uang/apps/api && bun test`
Expected: PASS — all suites green (owners, valuation, accounts, networth, and the pre-existing auth/entries/fx/onboarding/users/export tests).

- [ ] **Step 2: Build the web app**

Run: `cd /Users/aziz/Workspace/uang/apps/web && bun run build`
Expected: PASS — type-check + production build succeed.

- [ ] **Step 3: Manual E2E (the build gate for web behaviour)**

Start both apps (API then web dev server) and verify against a household with **two** members (invite a second member in Settings if needed):

1. **Create personal:** New account, leave only yourself checked → it appears with your name as owner; it counts in both Household and your personal headline.
2. **Create shared:** New account, check both members → row shows a "Shared · A, B" badge; included in Household but excluded from each member's personal headline.
3. **Toggle:** Switch the dashboard toggle Household → member → back. Only the hero number changes; the account list stays complete and unchanged.
4. **Edit owners:** Open a personal account → "Edit owners" → add the second member → Save. The badge flips to "Shared", and the household/member headlines update on return to the dashboard.
5. **Validation:** In the editor, deselect everyone → Save is disabled (cannot clear all owners).

- [ ] **Step 4: Final commit (if any manual fixups were needed)**

```bash
git add -A
git commit -m "test(uang): verify account-ownership slice end-to-end"
```

> If no fixups were needed, skip this commit.

---

## Self-Review (author checklist — already applied)

- **Spec coverage:** §3 data model → Task 1; backfill (§3) → Tasks 2-3; invariant (§4) → Task 4; API (§5) `GET /accounts` ownerIds, `POST` default+validate, `PATCH /:id/owners`, `GET /networth?owner=` → Tasks 5-6; UI (§6) dashboard toggle + rows, create form owners, detail display+editor → Tasks 9-11; components/boundaries (§7) owners lib, valuation owner option, OwnersField + NetWorthToggle → Tasks 2,4,8,10; testing (§8) valuation/backfill/routes units → Tasks 2,4,5,6, web build gate + manual E2E → Tasks 7-12.
- **Type consistency:** `ownerIds: string[]` and `shared: boolean` are used identically across `AccountValuation` (valuation.ts), `NetWorth.accounts` (dashboard), `AccountRow` (collections), and the API responses. Helpers `getOwnersByAccount`/`getAllOwnerSets`/`setOwners`/`backfillOwners`/`allUsersExist` keep one name each across tasks. Route is `PATCH /accounts/:id/owners` everywhere (web calls `api.accounts({ id }).owners.patch({ ownerIds })`).
- **Ordering gotcha:** `PATCH /:id/owners` is registered before `PATCH /:id` (Task 5) so the specific path wins.
```
