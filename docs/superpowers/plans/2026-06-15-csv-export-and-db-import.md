# CSV Export & `.db` Import — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a readable CSV export (ZIP of per-entity CSVs) and an admin-only `.db` import (full verbatim restore) to uang, alongside the existing raw `.db` export.

**Architecture:** New API endpoints `GET /export/csv` (zips denormalized CSVs built from the DB) and `POST /import` (validates an uploaded `.db`, auto-backs-up the live DB, then row-copies every table over it with FK enforcement off). Pure formatting helpers are unit-tested; routes are integration-tested via Bun's test harness. The settings page gains a CSV button and an admin-gated, backup-first restore flow.

**Tech Stack:** Bun, Elysia, Drizzle + libsql/SQLite, `@uang/shared` (SCALE/currencyDecimals), React + TanStack Query, shadcn Dialog, `fflate` (new dep, zip).

**Spec:** `docs/superpowers/specs/2026-06-15-csv-export-and-db-import-design.md`

**Command conventions:** All commands assume the repo root `/Users/aziz/Workspace/uang` as the working directory. Test/build commands `cd` into a package on a single line (e.g. `cd apps/api && bun test …`); **return to the repo root before each `git` step** (`cd /Users/aziz/Workspace/uang`). All `git add` paths below are repo-root-relative.

---

## File Structure

- **Create** `apps/api/src/lib/csv-export.ts` — pure CSV/decimal formatting helpers (`csvField`, `toCsv`, `minorToDecimal`, `scaledToDecimal`).
- **Create** `apps/api/src/lib/csv-export.test.ts` — unit tests for the helpers.
- **Create** `apps/api/src/lib/csv-bundle.ts` — `buildCsvBundle()`: loads domain data + computes holdings, returns `Record<filename, csvString>`.
- **Create** `apps/api/src/lib/db-import.ts` — `isSqliteFile`, `IMPORT_TABLES`, `validateUpload`, `replaceAllData`.
- **Create** `apps/api/src/lib/db-import.test.ts` — unit tests for `isSqliteFile` and `IMPORT_TABLES`.
- **Modify** `apps/api/src/routes/export.ts` — add `GET /export/csv`.
- **Modify** `apps/api/src/routes/export.test.ts` — add CSV-export route tests.
- **Create** `apps/api/src/routes/import.ts` — `POST /import` (admin-only multipart restore).
- **Create** `apps/api/src/routes/import.test.ts` — route tests (401/403/400/round-trip/backup).
- **Modify** `apps/api/src/app.ts` — mount `importRoutes`.
- **Modify** `apps/api/package.json` — add `fflate`.
- **Modify** `apps/web/src/routes/settings.tsx` — CSV export button + admin restore section.

---

## Task 1: CSV/decimal formatting helpers

**Files:**
- Create: `apps/api/src/lib/csv-export.ts`
- Test: `apps/api/src/lib/csv-export.test.ts`
- Modify: `apps/api/package.json` (add `fflate`)

- [ ] **Step 1: Add the `fflate` dependency**

Run:
```bash
cd apps/api && bun add fflate
```
Expected: `fflate` appears under `dependencies` in `apps/api/package.json` and the lockfile updates.

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/lib/csv-export.test.ts`:
```ts
import { expect, test } from "bun:test";
import { csvField, toCsv, minorToDecimal, scaledToDecimal } from "./csv-export";

test("csvField escapes commas, quotes, newlines; blanks null", () => {
  expect(csvField("plain")).toBe("plain");
  expect(csvField("a,b")).toBe('"a,b"');
  expect(csvField('he said "hi"')).toBe('"he said ""hi"""');
  expect(csvField("line1\nline2")).toBe('"line1\nline2"');
  expect(csvField(null)).toBe("");
  expect(csvField(42)).toBe("42");
});

test("toCsv builds header + rows terminated by CRLF", () => {
  expect(toCsv(["a", "b"], [[1, "x,y"]])).toBe('a,b\r\n1,"x,y"\r\n');
});

test("minorToDecimal honours currency decimals (exact, integer-based)", () => {
  expect(minorToDecimal(123456, "USD")).toBe("1234.56");
  expect(minorToDecimal(-5, "USD")).toBe("-0.05");
  expect(minorToDecimal(1000, "JPY")).toBe("1000");
  expect(minorToDecimal(1234, "BHD")).toBe("1.234");
});

test("scaledToDecimal (×1e8) trims trailing zeros", () => {
  expect(scaledToDecimal(150000000)).toBe("1.5");
  expect(scaledToDecimal(100000000)).toBe("1");
  expect(scaledToDecimal(-12345000)).toBe("-0.12345");
  expect(scaledToDecimal(0)).toBe("0");
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run:
```bash
cd apps/api && bun test src/lib/csv-export.test.ts
```
Expected: FAIL — `Cannot find module './csv-export'`.

- [ ] **Step 4: Implement the helpers**

Create `apps/api/src/lib/csv-export.ts`:
```ts
import { currencyDecimals } from "@uang/shared";

// RFC 4180 field escaping: quote when the value contains comma, quote, CR or LF.
export function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(
  headers: string[],
  rows: (string | number | null)[][],
): string {
  const lines = [headers.map(csvField).join(",")];
  for (const row of rows) lines.push(row.map(csvField).join(","));
  return lines.join("\r\n") + "\r\n";
}

// Exact (integer-based) conversion of a currency minor-unit amount to a decimal
// string, using the currency's decimal count (USD=2, JPY=0, BHD=3).
export function minorToDecimal(minor: number, currency: string): string {
  const dec = currencyDecimals(currency);
  const neg = minor < 0;
  const digits = Math.abs(minor).toString().padStart(dec + 1, "0");
  const cut = digits.length - dec;
  const intPart = digits.slice(0, cut);
  const frac = dec > 0 ? "." + digits.slice(cut) : "";
  return (neg ? "-" : "") + intPart + frac;
}

// Convert a SCALE (1e8) fixed-point integer to a decimal string, trimming
// trailing zeros. Used for transaction units and unit prices.
export function scaledToDecimal(scaled: number): string {
  const dec = 8;
  const neg = scaled < 0;
  const digits = Math.abs(scaled).toString().padStart(dec + 1, "0");
  const cut = digits.length - dec;
  const intPart = digits.slice(0, cut);
  const frac = digits.slice(cut).replace(/0+$/, "");
  return (neg ? "-" : "") + intPart + (frac ? "." + frac : "");
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run:
```bash
cd apps/api && bun test src/lib/csv-export.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
cd /Users/aziz/Workspace/uang
git add apps/api/src/lib/csv-export.ts apps/api/src/lib/csv-export.test.ts apps/api/package.json bun.lock
git commit -m "feat(export): add CSV/decimal formatting helpers + fflate dep"
```

---

## Task 2: CSV bundle builder + `GET /export/csv` route

**Files:**
- Create: `apps/api/src/lib/csv-bundle.ts`
- Modify: `apps/api/src/routes/export.ts`
- Test: `apps/api/src/routes/export.test.ts`

- [ ] **Step 1: Write the failing route tests**

Append to `apps/api/src/routes/export.test.ts` (add imports at the top of the file: `import { unzipSync, strFromU8 } from "fflate";` and `import { accountsRoutes } from "./accounts";`):
```ts
test("GET /export/csv without cookie returns 401", async () => {
  const res = await app.handle(new Request("http://localhost/export/csv"));
  expect(res.status).toBe(401);
});

test("GET /export/csv returns a zip containing the expected CSVs", async () => {
  const csvApp = makeApp(accountsRoutes, exportRoutes);
  const { cookie: c } = await initAndLogin({ app: csvApp });

  await csvApp.handle(
    new Request("http://localhost/accounts", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: c },
      body: JSON.stringify({
        name: "Checking",
        class: "asset",
        subtype: "bank",
        currency: "USD",
      }),
    }),
  );

  const res = await csvApp.handle(
    new Request("http://localhost/export/csv", { headers: { cookie: c } }),
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/zip");
  expect(res.headers.get("content-disposition") ?? "").toContain(".zip");

  const buf = new Uint8Array(await res.arrayBuffer());
  const files = unzipSync(buf);
  expect(Object.keys(files).sort()).toEqual([
    "accounts.csv",
    "goals.csv",
    "holdings.csv",
    "settings.csv",
    "transactions.csv",
  ]);

  const accountsCsv = strFromU8(files["accounts.csv"]);
  expect(accountsCsv.split("\r\n")[0]).toBe(
    "name,class,subtype,currency,institution,group,archived,growth_rate_pct,accessible_from_age,early_withdrawal,illiquid,liquidation_age",
  );
  expect(accountsCsv).toContain("Checking");
});
```

Note: `app`, `makeApp`, `initAndLogin`, and `exportRoutes` are already imported/defined at the top of this existing test file.

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
cd apps/api && bun test src/routes/export.test.ts
```
Expected: FAIL — `/export/csv` returns 404 (route not defined yet) so status assertions fail.

- [ ] **Step 3: Implement the bundle builder**

Create `apps/api/src/lib/csv-bundle.ts`:
```ts
import {
  accounts,
  groups,
  transactions,
  instruments,
  goals,
  settings,
  user,
} from "../db/schema";
import { db } from "../db/client";
import { accountPositions } from "./positions";
import { toCsv, minorToDecimal, scaledToDecimal } from "./csv-export";

// Builds the readable CSV bundle: filename -> CSV text. Values are denormalised
// (names instead of IDs) and decimalised. No market data (prices/fx) by design.
export async function buildCsvBundle(): Promise<Record<string, string>> {
  const [acctRows, groupRows, txRows, instRows, goalRows, settingRows, userRows] =
    await Promise.all([
      db.select().from(accounts),
      db.select().from(groups),
      db.select().from(transactions),
      db.select().from(instruments),
      db.select().from(goals),
      db.select().from(settings),
      db.select().from(user),
    ]);

  const groupName = new Map(groupRows.map((g) => [g.id, g.name]));
  const acctById = new Map(acctRows.map((a) => [a.id, a]));
  const instById = new Map(instRows.map((i) => [i.id, i]));
  const userName = new Map(userRows.map((u) => [u.id, u.name]));

  const accountsCsv = toCsv(
    [
      "name",
      "class",
      "subtype",
      "currency",
      "institution",
      "group",
      "archived",
      "growth_rate_pct",
      "accessible_from_age",
      "early_withdrawal",
      "illiquid",
      "liquidation_age",
    ],
    acctRows.map((a) => [
      a.name,
      a.class,
      a.subtype,
      a.currency,
      a.institution ?? "",
      a.groupId ? groupName.get(a.groupId) ?? "" : "",
      a.isArchived ? "true" : "false",
      String(a.growthRateBps / 100),
      String(a.accessibleFromAge),
      a.earlyWithdrawal,
      a.illiquid ? "true" : "false",
      a.liquidationAge === null ? "" : String(a.liquidationAge),
    ]),
  );

  const transactionsCsv = toCsv(
    [
      "date",
      "account",
      "instrument_symbol",
      "instrument_name",
      "units",
      "unit_price",
      "fees",
      "notes",
    ],
    txRows.map((t) => {
      const acct = acctById.get(t.accountId);
      const inst = instById.get(t.instrumentId);
      return [
        t.date,
        acct?.name ?? "",
        inst?.symbol ?? "",
        inst?.name ?? "",
        scaledToDecimal(t.unitsDelta),
        t.unitPriceScaled === null ? "" : scaledToDecimal(t.unitPriceScaled),
        acct ? minorToDecimal(t.feesMinor, acct.currency) : String(t.feesMinor),
        t.notes ?? "",
      ];
    }),
  );

  const holdingsRows: (string | number | null)[][] = [];
  for (const a of acctRows) {
    const positions = await accountPositions(a.id);
    for (const p of positions) {
      holdingsRows.push([
        a.name,
        p.instrument.symbol ?? "",
        p.instrument.name,
        scaledToDecimal(p.units),
        p.missingPrice
          ? ""
          : minorToDecimal(p.marketValueMinor, p.instrumentCurrency),
        p.instrumentCurrency,
      ]);
    }
  }
  const holdingsCsv = toCsv(
    [
      "account",
      "instrument_symbol",
      "instrument_name",
      "units",
      "current_value",
      "currency",
    ],
    holdingsRows,
  );

  const goalsCsv = toCsv(
    [
      "name",
      "target_amount",
      "currency",
      "target_date",
      "monthly_contribution",
      "owner",
      "spend_type",
      "spend_amount",
      "spend_rate_pct",
    ],
    goalRows.map((g) => [
      g.name,
      minorToDecimal(g.targetAmountMinor, g.currency),
      g.currency,
      g.targetDate ?? "",
      minorToDecimal(g.monthlyContributionMinor, g.currency),
      g.ownerScope === "household"
        ? "household"
        : userName.get(g.ownerScope) ?? g.ownerScope,
      g.spendType,
      g.spendAmountMinor === null
        ? ""
        : minorToDecimal(g.spendAmountMinor, g.currency),
      g.spendRateBps === null ? "" : String(g.spendRateBps / 100),
    ]),
  );

  const s = settingRows[0];
  const settingsCsv = toCsv(
    [
      "household_name",
      "base_currency",
      "contribution_growth_rate_pct",
      "projection_end_age",
    ],
    s
      ? [
          [
            s.householdName,
            s.baseCurrency,
            String(s.contributionGrowthRateBps / 100),
            String(s.projectionEndAge),
          ],
        ]
      : [],
  );

  return {
    "accounts.csv": accountsCsv,
    "transactions.csv": transactionsCsv,
    "holdings.csv": holdingsCsv,
    "goals.csv": goalsCsv,
    "settings.csv": settingsCsv,
  };
}
```

- [ ] **Step 4: Add the `GET /export/csv` route**

Modify `apps/api/src/routes/export.ts`. Add these imports at the top (keep the existing `Elysia`, `authGuard`, `sqlite` imports):
```ts
import { zipSync, strToU8 } from "fflate";
import { buildCsvBundle } from "../lib/csv-bundle";
```
Then add a `.get("/export/csv", ...)` handler to the existing `exportRoutes` chain (after the existing `/export` handler, before the closing `;`):
```ts
  .get("/export/csv", async () => {
    const bundle = await buildCsvBundle();
    const zipInput: Record<string, Uint8Array> = {};
    for (const [name, text] of Object.entries(bundle)) {
      zipInput[name] = strToU8(text);
    }
    const zipped = zipSync(zipInput);
    const today = new Date().toISOString().slice(0, 10);
    return new Response(zipped, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="uang-csv-${today}.zip"`,
      },
    });
  })
```

- [ ] **Step 5: Run the tests to verify they pass**

Run:
```bash
cd apps/api && bun test src/routes/export.test.ts
```
Expected: PASS (existing `.db` tests + 2 new CSV tests).

- [ ] **Step 6: Commit**

```bash
cd /Users/aziz/Workspace/uang
git add apps/api/src/lib/csv-bundle.ts apps/api/src/routes/export.ts apps/api/src/routes/export.test.ts
git commit -m "feat(export): add GET /export/csv readable CSV zip bundle"
```

---

## Task 3: `.db` import core (validation + row-copy)

**Files:**
- Create: `apps/api/src/lib/db-import.ts`
- Test: `apps/api/src/lib/db-import.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/lib/db-import.test.ts`:
```ts
import { expect, test } from "bun:test";
import { isSqliteFile, IMPORT_TABLES } from "./db-import";

test("isSqliteFile detects the SQLite magic header", () => {
  const ok = new TextEncoder().encode("SQLite format 3 and the rest...");
  expect(isSqliteFile(ok)).toBe(true);
  expect(isSqliteFile(new TextEncoder().encode("not a database"))).toBe(false);
  expect(isSqliteFile(new Uint8Array(4))).toBe(false);
});

test("IMPORT_TABLES covers domain + auth tables", () => {
  for (const t of [
    "settings",
    "accounts",
    "groups",
    "instruments",
    "transactions",
    "prices",
    "fx_rates",
    "account_owners",
    "member_profiles",
    "goals",
    "user",
    "session",
    "account",
    "verification",
  ]) {
    expect(IMPORT_TABLES).toContain(t);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
cd apps/api && bun test src/lib/db-import.test.ts
```
Expected: FAIL — `Cannot find module './db-import'`.

- [ ] **Step 3: Implement the import core**

Create `apps/api/src/lib/db-import.ts`:
```ts
import type { Client, InValue, InStatement } from "@libsql/client";

// Every table whose rows are replaced verbatim on import (domain + auth).
// Order is irrelevant: FK enforcement is disabled around the row copy.
export const IMPORT_TABLES = [
  "settings",
  "accounts",
  "groups",
  "instruments",
  "transactions",
  "prices",
  "fx_rates",
  "account_owners",
  "member_profiles",
  "goals",
  "user",
  "session",
  "account",
  "verification",
] as const;

// SQLite files begin with the 16-byte string "SQLite format 3\0".
export function isSqliteFile(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  return new TextDecoder().decode(bytes.subarray(0, 15)) === "SQLite format 3";
}

// Confirms the uploaded DB looks like a uang database before we touch live data.
export async function validateUpload(
  src: Client,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await src.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  );
  const names = new Set(res.rows.map((r) => String(r["name"])));
  for (const required of ["accounts", "settings", "user"]) {
    if (!names.has(required)) {
      return { ok: false, error: "not_a_uang_db" };
    }
  }
  return { ok: true };
}

// Replaces all known tables in `dst` with the rows from `src`, atomically.
// FK enforcement is turned off around the batch so delete/insert order is moot.
export async function replaceAllData(src: Client, dst: Client): Promise<void> {
  const stmts: InStatement[] = [];
  for (const table of IMPORT_TABLES) {
    stmts.push({ sql: `DELETE FROM "${table}"` });
    const res = await src.execute(`SELECT * FROM "${table}"`);
    const cols = res.columns;
    if (cols.length === 0) continue;
    const colList = cols.map((c) => `"${c}"`).join(", ");
    const placeholders = cols.map(() => "?").join(", ");
    for (const row of res.rows) {
      const args: InValue[] = cols.map((_, i) => row[i] as InValue);
      stmts.push({
        sql: `INSERT INTO "${table}" (${colList}) VALUES (${placeholders})`,
        args,
      });
    }
  }
  await dst.execute("PRAGMA foreign_keys = OFF");
  await dst.batch(stmts, "write");
  await dst.execute("PRAGMA foreign_keys = ON");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
cd apps/api && bun test src/lib/db-import.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/aziz/Workspace/uang
git add apps/api/src/lib/db-import.ts apps/api/src/lib/db-import.test.ts
git commit -m "feat(import): add .db validation + verbatim row-copy core"
```

---

## Task 4: `POST /import` route (admin restore) + mounting

**Files:**
- Create: `apps/api/src/routes/import.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/src/routes/import.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/routes/import.test.ts`:
```ts
import { expect, test, beforeEach } from "bun:test";
import { readdirSync } from "node:fs";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { importRoutes } from "./import";
import { exportRoutes } from "./export";
import { accountsRoutes } from "./accounts";
import { usersRoutes } from "./users";

beforeEach(resetDb);

function dummyDbForm() {
  const fd = new FormData();
  fd.append("file", new File(["SQLite format 3 junk"], "x.db"));
  return fd;
}

test("requires auth (401)", async () => {
  const app = makeApp(importRoutes);
  const res = await app.handle(
    new Request("http://localhost/import", {
      method: "POST",
      body: dummyDbForm(),
    }),
  );
  expect(res.status).toBe(401);
});

test("non-admin is forbidden (403)", async () => {
  const app = makeApp(importRoutes, usersRoutes);
  const { cookie: adminCookie } = await initAndLogin({ app });

  await app.handle(
    new Request("http://localhost/users", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({
        email: "member@test.com",
        name: "Member",
        password: "anothersecret1",
      }),
    }),
  );
  const signin = await app.handle(
    new Request("http://localhost/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "member@test.com",
        password: "anothersecret1",
      }),
    }),
  );
  const memberCookie = signin.headers.get("set-cookie") ?? "";

  const res = await app.handle(
    new Request("http://localhost/import", {
      method: "POST",
      headers: { cookie: memberCookie },
      body: dummyDbForm(),
    }),
  );
  expect(res.status).toBe(403);
});

test("rejects a non-SQLite upload (400)", async () => {
  const app = makeApp(importRoutes);
  const { cookie } = await initAndLogin({ app });
  const fd = new FormData();
  fd.append("file", new File(["not a database at all"], "x.db"));
  const res = await app.handle(
    new Request("http://localhost/import", {
      method: "POST",
      headers: { cookie },
      body: fd,
    }),
  );
  expect(res.status).toBe(400);
});

test("round-trip: export then import restores deleted data, writes a backup", async () => {
  const app = makeApp(accountsRoutes, exportRoutes, importRoutes);
  const { cookie } = await initAndLogin({ app });

  await app.handle(
    new Request("http://localhost/accounts", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        name: "Checking",
        class: "asset",
        subtype: "bank",
        currency: "USD",
      }),
    }),
  );

  const snapshot = await (
    await app.handle(
      new Request("http://localhost/export", { headers: { cookie } }),
    )
  ).arrayBuffer();

  const list = await (
    await app.handle(
      new Request("http://localhost/accounts", { headers: { cookie } }),
    )
  ).json();
  await app.handle(
    new Request(`http://localhost/accounts/${list[0].id}`, {
      method: "DELETE",
      headers: { cookie },
    }),
  );
  const mid = await (
    await app.handle(
      new Request("http://localhost/accounts", { headers: { cookie } }),
    )
  ).json();
  expect(mid.length).toBe(0);

  const backupsBefore = readdirSync("/tmp").filter((f) =>
    f.startsWith("uang-pre-import-"),
  ).length;

  const fd = new FormData();
  fd.append("file", new File([snapshot], "u.db"));
  const imp = await app.handle(
    new Request("http://localhost/import", {
      method: "POST",
      headers: { cookie },
      body: fd,
    }),
  );
  expect(imp.status).toBe(200);

  const backupsAfter = readdirSync("/tmp").filter((f) =>
    f.startsWith("uang-pre-import-"),
  ).length;
  expect(backupsAfter).toBeGreaterThan(backupsBefore);

  // cookie's session row was captured in the snapshot, so it is valid again.
  const after = await (
    await app.handle(
      new Request("http://localhost/accounts", { headers: { cookie } }),
    )
  ).json();
  expect(after.length).toBe(1);
  expect(after[0].name).toBe("Checking");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
cd apps/api && bun test src/routes/import.test.ts
```
Expected: FAIL — `Cannot find module './import'`.

- [ ] **Step 3: Implement the route**

Create `apps/api/src/routes/import.ts`:
```ts
import { Elysia, t } from "elysia";
import { createClient } from "@libsql/client";
import { authGuard } from "../lib/auth-guard";
import { sqlite } from "../db/client";
import { isSqliteFile, validateUpload, replaceAllData } from "../lib/db-import";

export const importRoutes = new Elysia()
  .use(authGuard)
  .post(
    "/import",
    async ({ body, isAdmin, set }: any) => {
      if (!isAdmin) {
        set.status = 403;
        return { error: "admin_only" };
      }

      const bytes = new Uint8Array(await body.file.arrayBuffer());
      if (!isSqliteFile(bytes)) {
        set.status = 400;
        return { error: "not_sqlite" };
      }

      // Stage the upload to a temp file and open it as a second connection.
      const tmpPath = `/tmp/uang-import-${Date.now()}.db`;
      const { Bun } = globalThis as unknown as {
        Bun: { write(path: string, data: Uint8Array): Promise<number> };
      };
      await Bun.write(tmpPath, bytes);
      const src = createClient({ url: `file:${tmpPath}` });

      const valid = await validateUpload(src);
      if (!valid.ok) {
        set.status = 400;
        return { error: valid.error };
      }

      // Defence-in-depth: snapshot the live DB before we overwrite it.
      await sqlite.execute(`VACUUM INTO '/tmp/uang-pre-import-${Date.now()}.db'`);

      await replaceAllData(src, sqlite);
      return { ok: true };
    },
    { body: t.Object({ file: t.File() }) },
  );
```

- [ ] **Step 4: Mount the route**

Modify `apps/api/src/app.ts`. Add the import near the other route imports:
```ts
import { importRoutes } from "./routes/import";
```
And register it in `createApiApp()` alongside the others (right after `.use(exportRoutes)`):
```ts
    .use(importRoutes)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run:
```bash
cd apps/api && bun test src/routes/import.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 6: Run the full API test suite**

Run:
```bash
cd apps/api && bun test
```
Expected: PASS (all suites, including the new ones).

- [ ] **Step 7: Commit**

```bash
cd /Users/aziz/Workspace/uang
git add apps/api/src/routes/import.ts apps/api/src/routes/import.test.ts apps/api/src/app.ts
git commit -m "feat(import): add admin-only POST /import .db restore endpoint"
```

---

## Task 5: Settings UI — CSV export button + backup-first restore

**Files:**
- Modify: `apps/web/src/routes/settings.tsx`

- [ ] **Step 1: Add imports**

In `apps/web/src/routes/settings.tsx`, add these imports below the existing ones:
```ts
import { useSession } from "@/lib/auth";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
```

- [ ] **Step 2: Add a restore-section component**

Add this component above `export function SettingsPage()` in the same file:
```tsx
function RestoreSection() {
  const { data: session } = useSession();
  const meId = session?.user?.id;
  const usersQ = useQuery({
    queryKey: ["users"],
    queryFn: async (): Promise<User[]> => {
      const { data, error } = await api.users.get();
      if (error) throw new Error(String(error));
      return (data as unknown as User[]) ?? [];
    },
  });
  const isAdmin =
    usersQ.data?.some((u) => u.id === meId && u.isAdmin) ?? false;

  const [backedUp, setBackedUp] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isAdmin) return null;

  async function doImport() {
    if (!file) return;
    setImporting(true);
    setError(null);
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`${API_URL}/import`, {
      method: "POST",
      body: fd,
      credentials: "include",
    });
    if (res.ok) {
      window.location.href = "/login";
      return;
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    setError(body.error ?? "Import failed");
    setImporting(false);
    setConfirmOpen(false);
  }

  return (
    <Section
      eyebrow="Restore"
      title="Restore from a backup"
      description="Replace ALL data with the contents of a uang .db file. This signs everyone out. Download a backup of your current data first."
    >
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <span className="flex size-6 items-center justify-center rounded-full border border-border text-xs">
            1
          </span>
          <a
            href={`${API_URL}/export`}
            download
            onClick={() => setBackedUp(true)}
          >
            <Button variant="outline">Download current backup (.db)</Button>
          </a>
        </div>

        <div className="flex items-center gap-3">
          <span className="flex size-6 items-center justify-center rounded-full border border-border text-xs">
            2
          </span>
          <Input
            type="file"
            accept=".db"
            disabled={!backedUp}
            className="w-auto"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setFile(f);
              setError(null);
              if (f) setConfirmOpen(true);
            }}
          />
          {!backedUp && (
            <span className="text-sm text-muted-foreground">
              Download a backup first
            </span>
          )}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Replace all data?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This permanently replaces every account, transaction, goal, and
            member with the contents of{" "}
            <span className="font-medium">{file?.name}</span>, and signs everyone
            out. This cannot be undone from the app.
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              disabled={importing}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={doImport}
              disabled={importing || !file}
            >
              {importing ? "Restoring…" : "Replace all data"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Section>
  );
}
```

- [ ] **Step 3: Add the CSV button and mount the restore section**

In `SettingsPage()`, replace the existing Backup `<Section>` (the one with `eyebrow="Backup"`) with:
```tsx
        <Section
          eyebrow="Backup"
          title="Export your data"
          description="Download the full database as a SQLite file, or a zip of readable CSVs."
        >
          <div className="flex flex-wrap gap-3">
            <a href={`${API_URL}/export`}>
              <Button variant="outline">Export database (.db)</Button>
            </a>
            <a href={`${API_URL}/export/csv`}>
              <Button variant="outline">Export as CSV (.zip)</Button>
            </a>
          </div>
        </Section>

        <RestoreSection />
```

- [ ] **Step 4: Typecheck + build the web app**

Run:
```bash
cd apps/web && bun run build
```
Expected: build succeeds with no type errors (this is the project's strict typecheck per the build memory).

- [ ] **Step 5: Commit**

```bash
cd /Users/aziz/Workspace/uang
git add apps/web/src/routes/settings.tsx
git commit -m "feat(web): CSV export button + admin backup-first restore flow"
```

---

## Task 6: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the entire API test suite**

Run:
```bash
cd apps/api && bun test
```
Expected: PASS (all suites).

- [ ] **Step 2: Typecheck the whole web app once more**

Run:
```bash
cd apps/web && bun run build
```
Expected: PASS (no type errors). If the API route types changed, the Eden `App` type flows through here.

- [ ] **Step 3: Final commit (if anything was adjusted)**

```bash
cd /Users/aziz/Workspace/uang
git add apps/api apps/web
git commit -m "chore: finalize CSV export and .db import" || echo "nothing to commit"
```

---

## Notes for the implementer

- **No `as any`.** The route context destructuring `({ body, isAdmin, set }: any)` is the one sanctioned exception (existing Elysia convention). The `row[i] as InValue` cast in `db-import.ts` is a specific assertion, not `any` — keep it specific.
- **`fees` currency:** transaction fees are emitted in the owning account's currency (`minorToDecimal(t.feesMinor, acct.currency)`).
- **`unit_price` may be null** for currency-kind transactions — emitted as blank.
- **Holdings are derived** via `accountPositions()`; missing-price positions emit a blank `current_value` but still list units.
- **Import is verbatim and total:** it replaces auth tables too, so the importing admin must have their own user/session inside the file (true for restoring your own export). Sessions are replaced → the web flow redirects to `/login`.
- **Backup-first gate** is enforced client-side: Step 2's file input stays disabled until the Step 1 download is clicked. The server also writes a `/tmp/uang-pre-import-*.db` snapshot regardless.
