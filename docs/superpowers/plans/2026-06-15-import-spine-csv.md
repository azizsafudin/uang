# Import Spine + CSV Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user upload a bank/credit-card CSV, parse it with a reusable declarative parser, review/dedup the rows, and commit them as cash transactions on an account — with **no AI** (that's Spec 3).

**Architecture:** A format-agnostic import pipeline. Pure functions parse a CSV into canonical rows (date / signed `amountMinor` / description), dedup them against existing transactions, and stage them in three new tables (`import_parsers`, `import_batches`, `import_rows`). API routes drive upload→stage→review→commit. Committed rows become `transactions` on the account's currency instrument, tagged with `importBatchId` for traceability. Parsers are user-editable JSON config; detection matches a file's header fingerprint to a saved parser and suggests it.

**Tech Stack:** Bun, Elysia, Drizzle (libsql/SQLite), `@uang/shared` (money scaling), React + TanStack Router/Query/DB, shadcn/ui, Eden treaty (end-to-end types), Playwright (e2e).

**Conventions (from CLAUDE.md + codebase):**
- **Never `as any`.** Model types precisely. The only tolerated `any` is Elysia route-context destructuring (`async ({ body, set }: any) =>`), matching existing routes.
- Money: units are integers ×`SCALE` (1e8). `currencyDecimals(code)` gives minor-unit digits. Cash instruments are priced at `SCALE` (1.0).
- IDs: `createId()` (uuid). Time: `nowEpoch()` (unix seconds).
- Tests: `bun test`. Route tests use `makeApp(...routes)` + `initAndLogin()` from `lib/test-helpers`, `beforeEach(resetDb)`.
- **Typecheck is via the web build:** `cd apps/web && bun run build` (tsgo). `bun test` does NOT strict-typecheck.
- New routes added to `createApiApp()` flow into the Eden `App` type automatically — no manual client wiring.

---

## File Structure

**API — new pure libs (`apps/api/src/lib/import/`):**
- `types.ts` — `ParserConfig` (CSV), `CanonicalRow`, `ParserFingerprint` types.
- `dates.ts` — `parseDate(raw, format)` → `"YYYY-MM-DD" | null`.
- `amount.ts` — `parseAmountToMinor`, `amountMinorToUnitsDelta`, `unitsDeltaToAmountMinor`.
- `csv.ts` — `parseDelimited(content, delimiter)` + `parseCsv(content, config)` → `CanonicalRow[]`.
- `dedup.ts` — `normalizeDescription`, `dedupHash`.
- `detect.ts` — `fingerprintCsv`, `matchParsers`.
- `validate.ts` — `validateParserConfig(unknown)` → `ParserConfig` (throws on bad shape).

**API — new routes:**
- `routes/import-parsers.ts` — CRUD for saved parsers.
- `routes/imports.ts` — detect, parse-to-batch, get batch, edit row, commit, discard.

**API — modified:**
- `db/schema.ts` — 3 new tables + `transactions.importBatchId`.
- `app.ts` — register the two new route plugins.
- `lib/test-helpers.ts` — clear the new tables in `resetDb`.

**Web — new:**
- `components/import-dialog.tsx` — upload + parser select/create + kick off parse.
- `components/import-review.tsx` — review table + commit.
- `components/ui/table.tsx`, `components/ui/checkbox.tsx` — via shadcn CLI.

**Web — modified:**
- `components/account-history.tsx` or `routes/account-detail.tsx` — add an "Import statement" entry point next to "Add transaction".

**e2e — new:**
- `e2e/tests/import.spec.ts` — happy-path CSV import.

---

## Canonical data contract (read before coding)

`CanonicalRow.amountMinor` is the **signed delta applied to the account's cash position**, in minor units. Positive = the account's cash increases (deposit / refund / income); negative = decreases (withdrawal / card charge). The parser's `sign` option maps the file's own convention onto this. Commit converts it directly: `unitsDelta = amountMinorToUnitsDelta(amountMinor, currency)`, `unitPriceScaled = SCALE`, `notes = description`. This keeps commit trivial and puts all sign semantics in the (reviewable, editable) parser config — important for credit cards, where the user picks the convention that matches their existing manual entries.

---

### Task 1: Schema — 3 new tables + `transactions.importBatchId`

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Modify: `apps/api/src/lib/test-helpers.ts`
- Test: `apps/api/src/db/import-schema.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/db/import-schema.test.ts`:

```typescript
import { expect, test, beforeEach } from "bun:test";
import { db } from "./client";
import { importParsers, importBatches, importRows } from "./schema";
import { resetDb } from "../lib/test-helpers";
import { createId, nowEpoch } from "../lib/ids";

beforeEach(resetDb);

test("import tables accept rows and round-trip", async () => {
  const parserId = createId();
  await db.insert(importParsers).values({
    id: parserId, name: "DBS Statement Parser", sourceFormat: "csv",
    config: JSON.stringify({ version: 1, format: "csv" }),
    fingerprint: JSON.stringify({ format: "csv", headerColumns: ["amount", "date"] }),
    origin: "manual", createdAt: nowEpoch(), createdBy: "u",
  });
  const batchId = createId();
  await db.insert(importBatches).values({
    id: batchId, parserId, accountId: "acc1", filename: "feb.csv",
    fileHash: "abc", status: "review", rowCountNew: 1, rowCountDuplicate: 0,
    rowCountError: 0, createdAt: nowEpoch(), createdBy: "u",
  });
  await db.insert(importRows).values({
    id: createId(), batchId, raw: JSON.stringify({ Date: "01 Feb 2026" }),
    date: "2026-02-01", amountMinor: -1234, description: "COFFEE",
    category: null, dedupHash: "h1", status: "new", errorReason: null,
    matchedTxnId: null, committedTxnId: null,
  });

  const parsers = await db.select().from(importParsers);
  const batches = await db.select().from(importBatches);
  const rows = await db.select().from(importRows);
  expect(parsers.length).toBe(1);
  expect(batches[0].status).toBe("review");
  expect(rows[0].amountMinor).toBe(-1234);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun test src/db/import-schema.test.ts`
Expected: FAIL — `importParsers`/`importBatches`/`importRows` are not exported from schema.

- [ ] **Step 3: Add the tables to the schema**

In `apps/api/src/db/schema.ts`, add `importBatchId` to the existing `transactions` table (after `notes`):

```typescript
  notes: text("notes"),
  importBatchId: text("import_batch_id"), // nullable logical FK → import_batches.id (traceability)
```

Then append these tables (before the final `export * from "./auth-schema";`):

```typescript
// A reusable, user-editable declarative parser for a statement format.
// `config` and `fingerprint` are JSON strings (see lib/import/types.ts).
export const importParsers = sqliteTable("import_parsers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  sourceFormat: text("source_format").$type<"csv" | "ofx" | "qif" | "pdf">().notNull(),
  config: text("config").notNull(),
  fingerprint: text("fingerprint").notNull(),
  origin: text("origin").$type<"ai" | "manual">().notNull().default("manual"),
  createdAt: integer("created_at").notNull(),
  createdBy: text("created_by").notNull(),
});

// One per uploaded file. fileHash short-circuits exact re-uploads.
export const importBatches = sqliteTable("import_batches", {
  id: text("id").primaryKey(),
  parserId: text("parser_id").notNull(),  // logical FK → import_parsers.id
  accountId: text("account_id").notNull(),
  filename: text("filename").notNull(),
  fileHash: text("file_hash").notNull(),
  status: text("status").$type<"parsing" | "review" | "committed" | "discarded">().notNull(),
  rowCountNew: integer("row_count_new").notNull().default(0),
  rowCountDuplicate: integer("row_count_duplicate").notNull().default(0),
  rowCountError: integer("row_count_error").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  createdBy: text("created_by").notNull(),
});

// Staged canonical rows for a batch. `category` is reserved (Spec: ledger-only now).
export const importRows = sqliteTable("import_rows", {
  id: text("id").primaryKey(),
  batchId: text("batch_id").notNull(),  // FK → import_batches.id
  raw: text("raw").notNull(),           // JSON: original header→cell map
  date: text("date"),                   // YYYY-MM-DD | null (null => error row)
  amountMinor: integer("amount_minor"), // signed minor units | null
  description: text("description").notNull().default(""),
  category: text("category"),           // reserved, unused in v1
  dedupHash: text("dedup_hash").notNull(),
  status: text("status").$type<"new" | "duplicate" | "excluded" | "error">().notNull(),
  errorReason: text("error_reason"),
  matchedTxnId: text("matched_txn_id"),
  committedTxnId: text("committed_txn_id"),
}, (t) => [index("import_rows_batch_idx").on(t.batchId)]);
```

- [ ] **Step 4: Clear the new tables in `resetDb`**

In `apps/api/src/lib/test-helpers.ts`, add the imports and deletes. Update the schema import line to include the new tables:

```typescript
import { settings, user, accounts, accountOwners, memberProfiles, goals, groups, transactions, fxRates, instruments, prices, importParsers, importBatches, importRows } from "../db/schema";
```

And add these deletes at the top of `resetDb` (before `db.delete(accountOwners)`):

```typescript
  await db.delete(importRows);
  await db.delete(importBatches);
  await db.delete(importParsers);
```

- [ ] **Step 5: Generate the migration**

Run: `cd apps/api && bun run db:generate`
Expected: a new file `apps/api/drizzle/0008_*.sql` is created containing `CREATE TABLE import_parsers/import_batches/import_rows` and `ALTER TABLE transactions ADD import_batch_id`.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd apps/api && bun test src/db/import-schema.test.ts`
Expected: PASS (3 assertions). `resetDb` applies the new migration automatically.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/src/lib/test-helpers.ts apps/api/src/db/import-schema.test.ts apps/api/drizzle
git commit -m "feat(import): add import_parsers/batches/rows tables + transactions.importBatchId"
```

---

### Task 2: Date parsing (`dates.ts`)

**Files:**
- Create: `apps/api/src/lib/import/dates.ts`
- Test: `apps/api/src/lib/import/dates.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { expect, test } from "bun:test";
import { parseDate } from "./dates";

test("parses common statement date formats to YYYY-MM-DD", () => {
  expect(parseDate("01 Feb 2026", "DD MMM YYYY")).toBe("2026-02-01");
  expect(parseDate("2/1/2026", "M/D/YYYY")).toBe("2026-02-01");
  expect(parseDate("01/02/2026", "DD/MM/YYYY")).toBe("2026-02-01");
  expect(parseDate("2026-02-01", "YYYY-MM-DD")).toBe("2026-02-01");
  expect(parseDate("01-Feb-26", "DD-MMM-YY")).toBe("2026-02-01");
});

test("returns null for unparseable input", () => {
  expect(parseDate("", "DD MMM YYYY")).toBeNull();
  expect(parseDate("not a date", "DD MMM YYYY")).toBeNull();
  expect(parseDate("31 Foo 2026", "DD MMM YYYY")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun test src/lib/import/dates.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/api/src/lib/import/dates.ts`:

```typescript
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// Build a regex + capture plan from a token format string. Supported tokens:
// YYYY, YY, MMMM, MMM, MM, M, DD, D. Any other run of chars is treated literally.
type Part = { kind: "year" | "month" | "monthName" | "day" | "literal"; len?: number };

function compile(format: string): { re: RegExp; parts: Part[] } {
  const tokens = ["YYYY", "YY", "MMMM", "MMM", "MM", "M", "DD", "D"];
  const parts: Part[] = [];
  let src = "";
  let i = 0;
  while (i < format.length) {
    const tok = tokens.find((t) => format.startsWith(t, i));
    if (tok === "YYYY") { parts.push({ kind: "year" }); src += "(\\d{4})"; i += 4; }
    else if (tok === "YY") { parts.push({ kind: "year" }); src += "(\\d{2})"; i += 2; }
    else if (tok === "MMMM" || tok === "MMM") { parts.push({ kind: "monthName" }); src += "([A-Za-z]+)"; i += tok.length; }
    else if (tok === "MM") { parts.push({ kind: "month" }); src += "(\\d{1,2})"; i += 2; }
    else if (tok === "M") { parts.push({ kind: "month" }); src += "(\\d{1,2})"; i += 1; }
    else if (tok === "DD") { parts.push({ kind: "day" }); src += "(\\d{1,2})"; i += 2; }
    else if (tok === "D") { parts.push({ kind: "day" }); src += "(\\d{1,2})"; i += 1; }
    else { src += format[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); i += 1; }
  }
  return { re: new RegExp(`^\\s*${src}\\s*$`), parts };
}

export function parseDate(raw: string, format: string): string | null {
  if (!raw || !raw.trim()) return null;
  const { re, parts } = compile(format);
  const m = re.exec(raw);
  if (!m) return null;
  let year = 0, month = 0, day = 0;
  parts.forEach((p, idx) => {
    const g = m[idx + 1];
    if (p.kind === "year") year = g.length === 2 ? 2000 + Number(g) : Number(g);
    else if (p.kind === "month") month = Number(g);
    else if (p.kind === "monthName") month = MONTHS[g.slice(0, 3).toLowerCase()] ?? 0;
    else if (p.kind === "day") day = Number(g);
  });
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && bun test src/lib/import/dates.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/import/dates.ts apps/api/src/lib/import/dates.test.ts
git commit -m "feat(import): token-based statement date parser"
```

---

### Task 3: Amount parsing + unit conversion (`amount.ts`)

**Files:**
- Create: `apps/api/src/lib/import/amount.ts`
- Test: `apps/api/src/lib/import/amount.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { expect, test } from "bun:test";
import { SCALE } from "@uang/shared";
import { parseAmountToMinor, amountMinorToUnitsDelta, unitsDeltaToAmountMinor } from "./amount";

const S = Number(SCALE);

test("parses amounts with separators, signs, parentheses, symbols", () => {
  const o = { decimal: ".", thousands: ",", currency: "USD" };
  expect(parseAmountToMinor("1,234.56", o)).toBe(123456);
  expect(parseAmountToMinor("-12.00", o)).toBe(-1200);
  expect(parseAmountToMinor("(45.00)", o)).toBe(-4500);   // accounting negative
  expect(parseAmountToMinor("$ 9.99", o)).toBe(999);
  expect(parseAmountToMinor("", o)).toBeNull();
});

test("parses European 1.234,56 style", () => {
  expect(parseAmountToMinor("1.234,56", { decimal: ",", thousands: ".", currency: "USD" })).toBe(123456);
});

test("respects currency minor-unit digits (JPY=0)", () => {
  expect(parseAmountToMinor("1500", { decimal: ".", thousands: ",", currency: "JPY" })).toBe(1500);
});

test("converts minor units <-> unitsDelta exactly", () => {
  expect(amountMinorToUnitsDelta(1005, "USD")).toBe(10.05 * S);   // $10.05
  expect(amountMinorToUnitsDelta(-1005, "USD")).toBe(-10.05 * S);
  expect(unitsDeltaToAmountMinor(10.05 * S, "USD")).toBe(1005);
  expect(unitsDeltaToAmountMinor(-10.05 * S, "USD")).toBe(-1005);
  // round-trip through both directions
  expect(unitsDeltaToAmountMinor(amountMinorToUnitsDelta(1500, "JPY"), "JPY")).toBe(1500);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun test src/lib/import/amount.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/api/src/lib/import/amount.ts`:

```typescript
import { SCALE, currencyDecimals } from "@uang/shared";

export interface AmountFormat {
  decimal: string;   // "." or ","
  thousands: string; // "," "." " " or ""
  currency: string;
}

// Parse a raw amount cell into signed minor units. Handles thousands/decimal
// marks, leading minus, accounting parentheses, and stray currency symbols.
export function parseAmountToMinor(raw: string, fmt: AmountFormat): number | null {
  if (raw == null) return null;
  let s = raw.trim();
  if (s === "") return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (fmt.thousands) s = s.split(fmt.thousands).join("");
  if (fmt.decimal !== ".") s = s.split(fmt.decimal).join(".");
  if (s.includes("-")) { negative = negative || s.includes("-"); }
  s = s.replace(/[^0-9.]/g, "");
  if (s === "" || s === ".") return null;
  const value = Number(s);
  if (!Number.isFinite(value)) return null;
  const dec = currencyDecimals(fmt.currency);
  const minor = Math.round(value * 10 ** dec);
  return negative ? -minor : minor;
}

// minor units (e.g. cents) -> signed unitsDelta (×1e8). Exact: SCALE is
// divisible by 10^dec for dec <= 8.
export function amountMinorToUnitsDelta(amountMinor: number, currency: string): number {
  const dec = BigInt(currencyDecimals(currency));
  const abs = BigInt(Math.abs(amountMinor));
  const units = (abs * SCALE) / 10n ** dec;
  return Number(amountMinor < 0 ? -units : units);
}

// Inverse of amountMinorToUnitsDelta — reconstruct minor units from a stored
// transaction's unitsDelta (used for deduping against existing transactions).
export function unitsDeltaToAmountMinor(unitsDelta: number, currency: string): number {
  const dec = BigInt(currencyDecimals(currency));
  const abs = BigInt(Math.abs(unitsDelta));
  const minor = (abs * 10n ** dec) / SCALE;
  return Number(unitsDelta < 0 ? -minor : minor);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && bun test src/lib/import/amount.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/import/amount.ts apps/api/src/lib/import/amount.test.ts
git commit -m "feat(import): amount parsing + minor<->unitsDelta conversion"
```

---

### Task 4: Types + CSV engine (`types.ts`, `csv.ts`)

**Files:**
- Create: `apps/api/src/lib/import/types.ts`
- Create: `apps/api/src/lib/import/csv.ts`
- Test: `apps/api/src/lib/import/csv.test.ts`

- [ ] **Step 1: Create the types (no test — consumed by csv.ts)**

Create `apps/api/src/lib/import/types.ts`:

```typescript
// ---- Canonical row: the engine's output, before persistence ----
export interface CanonicalRow {
  raw: Record<string, string>;     // header -> cell, for audit
  date: string | null;             // YYYY-MM-DD
  amountMinor: number | null;      // signed; + = account cash increases
  description: string;
  error?: string;                  // set when the row could not be parsed
}

// ---- Declarative parser config (v1: CSV only; union grows in later specs) ----
export interface CsvAmountSingle {
  mode: "single";
  column: string;
  decimal: string;
  thousands: string;
  sign: "negativeIsDebit" | "positiveIsDebit";
}
export interface CsvAmountDebitCredit {
  mode: "debitCredit";
  debitColumn: string;
  creditColumn: string;
  decimal: string;
  thousands: string;
}
export interface CsvParserConfig {
  version: 1;
  format: "csv";
  csv: { delimiter: string; headerRow: number; skipRows: number };
  fields: {
    date: { column: string; format: string };
    description: { column: string };
    amount: CsvAmountSingle | CsvAmountDebitCredit;
  };
  rowFilter?: { dropIfBlank?: Array<"date" | "amount" | "description"> };
}

export type ParserConfig = CsvParserConfig;

// ---- Detection fingerprint ----
export interface CsvFingerprint {
  format: "csv";
  delimiter: string;
  headerColumns: string[]; // normalized, sorted
}
export type ParserFingerprint = CsvFingerprint;
```

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/lib/import/csv.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { parseDelimited, parseCsv } from "./csv";
import type { CsvParserConfig } from "./types";

test("parseDelimited handles quotes, embedded commas, and CRLF", () => {
  const rows = parseDelimited('a,b\r\n"x,y","he said ""hi"""\n', ",");
  expect(rows).toEqual([["a", "b"], ["x,y", 'he said "hi"']]);
});

const dbsConfig: CsvParserConfig = {
  version: 1, format: "csv",
  csv: { delimiter: ",", headerRow: 0, skipRows: 0 },
  fields: {
    date: { column: "Date", format: "DD MMM YYYY" },
    description: { column: "Description" },
    amount: { mode: "single", column: "Amount", decimal: ".", thousands: ",", sign: "negativeIsDebit" },
  },
  rowFilter: { dropIfBlank: ["date", "amount"] },
};

test("parseCsv maps rows to canonical form (single signed amount)", () => {
  const csv = [
    "Date,Description,Amount",
    "01 Feb 2026,COFFEE BEAN,-4.50",
    "03 Feb 2026,SALARY,3,000.00",     // note: thousands inside an unquoted field would split — see below
  ].join("\n");
  // Use a quoted thousands value to keep the field intact:
  const csv2 = [
    "Date,Description,Amount",
    "01 Feb 2026,COFFEE BEAN,-4.50",
    '03 Feb 2026,SALARY,"3,000.00"',
  ].join("\n");
  const rows = parseCsv(csv2, dbsConfig);
  expect(rows.length).toBe(2);
  expect(rows[0]).toMatchObject({ date: "2026-02-01", amountMinor: -450, description: "COFFEE BEAN" });
  expect(rows[1]).toMatchObject({ date: "2026-02-03", amountMinor: 300000, description: "SALARY" });
});

test("positiveIsDebit flips the sign", () => {
  const cfg: CsvParserConfig = { ...dbsConfig, fields: { ...dbsConfig.fields,
    amount: { mode: "single", column: "Amount", decimal: ".", thousands: ",", sign: "positiveIsDebit" } } };
  const rows = parseCsv("Date,Description,Amount\n01 Feb 2026,FEE,5.00", cfg);
  expect(rows[0].amountMinor).toBe(-500);
});

test("debitCredit mode computes credit - debit", () => {
  const cfg: CsvParserConfig = {
    version: 1, format: "csv", csv: { delimiter: ",", headerRow: 0, skipRows: 0 },
    fields: {
      date: { column: "Date", format: "YYYY-MM-DD" },
      description: { column: "Desc" },
      amount: { mode: "debitCredit", debitColumn: "Debit", creditColumn: "Credit", decimal: ".", thousands: "," },
    },
  };
  const csv = "Date,Desc,Debit,Credit\n2026-02-01,ATM,100.00,\n2026-02-02,PAY,,2500.00";
  const rows = parseCsv(csv, cfg);
  expect(rows[0].amountMinor).toBe(-10000); // debit
  expect(rows[1].amountMinor).toBe(250000); // credit
});

test("unparseable date/amount yields an error row; dropIfBlank skips noise", () => {
  const csv = [
    "Date,Description,Amount",
    "garbage,FOO,1.00",       // bad date -> error row
    ",,",                     // all blank -> dropped (date & amount blank)
  ].join("\n");
  const rows = parseCsv(csv, dbsConfig);
  expect(rows.length).toBe(1);
  expect(rows[0].error).toBeDefined();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/api && bun test src/lib/import/csv.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

Create `apps/api/src/lib/import/csv.ts`:

```typescript
import { parseDate } from "./dates";
import { parseAmountToMinor } from "./amount";
import type { CanonicalRow, CsvParserConfig } from "./types";

// Minimal RFC-4180-ish delimited parser: quoted fields, "" escapes, CRLF.
export function parseDelimited(content: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let started = false;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { pushField(); rows.push(row); row = []; started = false; };
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    started = true;
    if (inQuotes) {
      if (c === '"') {
        if (content[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delimiter) pushField();
    else if (c === "\n") pushRow();
    else if (c === "\r") { /* swallow; \r\n handled by \n */ }
    else field += c;
  }
  if (started || field !== "" || row.length > 0) pushRow();
  return rows;
}

function isBlankRow(cells: string[]): boolean {
  return cells.length === 0 || cells.every((c) => c.trim() === "");
}

export function parseCsv(content: string, config: CsvParserConfig): CanonicalRow[] {
  const all = parseDelimited(content, config.csv.delimiter);
  const header = (all[config.csv.headerRow] ?? []).map((h) => h.trim());
  const idxOf = (name: string) => header.findIndex((h) => h === name.trim());
  const dataStart = config.csv.headerRow + 1 + config.csv.skipRows;
  const dropIfBlank = config.rowFilter?.dropIfBlank ?? [];
  const out: CanonicalRow[] = [];

  for (let r = dataStart; r < all.length; r++) {
    const cells = all[r];
    if (isBlankRow(cells)) continue;

    const raw: Record<string, string> = {};
    header.forEach((h, i) => { raw[h] = cells[i] ?? ""; });

    const dateCell = cells[idxOf(config.fields.date.column)] ?? "";
    const descCell = cells[idxOf(config.fields.description.column)] ?? "";

    // amount raw presence (for dropIfBlank) + parsed value
    let amountRawBlank: boolean;
    let amountMinor: number | null;
    const a = config.fields.amount;
    if (a.mode === "single") {
      const cell = cells[idxOf(a.column)] ?? "";
      amountRawBlank = cell.trim() === "";
      const parsed = parseAmountToMinor(cell, { decimal: a.decimal, thousands: a.thousands, currency: "USD_PLACEHOLDER" });
      // currency-correct rounding happens at parse time; we re-parse with the
      // account currency in the route. Here we only need a value/sign, and
      // minor-unit scaling is currency-independent for whole/zero-decimal cases.
      amountMinor = parsed;
      if (amountMinor !== null && a.sign === "positiveIsDebit") amountMinor = -amountMinor;
    } else {
      const dCell = cells[idxOf(a.debitColumn)] ?? "";
      const cCell = cells[idxOf(a.creditColumn)] ?? "";
      amountRawBlank = dCell.trim() === "" && cCell.trim() === "";
      const debit = parseAmountToMinor(dCell, { decimal: a.decimal, thousands: a.thousands, currency: "USD_PLACEHOLDER" }) ?? 0;
      const credit = parseAmountToMinor(cCell, { decimal: a.decimal, thousands: a.thousands, currency: "USD_PLACEHOLDER" }) ?? 0;
      amountMinor = credit - debit;
    }

    const date = parseDate(dateCell, config.fields.date.format);

    // dropIfBlank: skip known noise rows entirely (summaries, totals)
    const blank = { date: dateCell.trim() === "", amount: amountRawBlank, description: descCell.trim() === "" };
    if (dropIfBlank.some((f) => blank[f])) continue;

    const row: CanonicalRow = { raw, date, amountMinor, description: descCell.trim() };
    if (date === null) row.error = "unparseable_date";
    else if (amountMinor === null) row.error = "unparseable_amount";
    out.push(row);
  }
  return out;
}
```

> **Note on currency:** `parseCsv` parses amounts with a placeholder currency so it stays pure and currency-agnostic. The route (Task 6) re-derives `amountMinor` against the *account's* currency by re-parsing the raw amount with the correct minor-unit digits before staging. The csv test above uses 2-decimal values, where the placeholder and USD agree. Keep that re-parse step in the route.

Wait — that split is error-prone. **Simplify: pass the account currency into `parseCsv`.** Update `parseCsv` signature to `(content, config, currency)` and replace `"USD_PLACEHOLDER"` with `currency`. Update the test calls to `parseCsv(csv, cfg, "USD")`. This keeps a single parse path.

- [ ] **Step 5: Apply the currency-param simplification**

Change the signature to:

```typescript
export function parseCsv(content: string, config: CsvParserConfig, currency: string): CanonicalRow[] {
```

Replace both `"USD_PLACEHOLDER"` occurrences with `currency`. In `csv.test.ts`, update every `parseCsv(x, cfg)` call to `parseCsv(x, cfg, "USD")`. Delete the placeholder note comment.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd apps/api && bun test src/lib/import/csv.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/import/types.ts apps/api/src/lib/import/csv.ts apps/api/src/lib/import/csv.test.ts
git commit -m "feat(import): declarative CSV parsing engine + canonical rows"
```

---

### Task 5: Dedup hashing (`dedup.ts`)

**Files:**
- Create: `apps/api/src/lib/import/dedup.ts`
- Test: `apps/api/src/lib/import/dedup.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { expect, test } from "bun:test";
import { normalizeDescription, dedupHash } from "./dedup";

test("normalizeDescription collapses case and whitespace", () => {
  expect(normalizeDescription("  COFFEE   BEAN ")).toBe("coffee bean");
});

test("dedupHash is stable and sensitive to the key fields", () => {
  const a = dedupHash("acc1", { date: "2026-02-01", amountMinor: -450, description: "Coffee  Bean" });
  const b = dedupHash("acc1", { date: "2026-02-01", amountMinor: -450, description: "coffee bean" });
  const c = dedupHash("acc1", { date: "2026-02-01", amountMinor: -451, description: "coffee bean" });
  expect(a).toBe(b);          // normalization makes these equal
  expect(a).not.toBe(c);      // different amount
  expect(a).toHaveLength(64); // sha256 hex
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun test src/lib/import/dedup.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/api/src/lib/import/dedup.ts`:

```typescript
import { createHash } from "node:crypto";

export function normalizeDescription(d: string): string {
  return d.trim().toLowerCase().replace(/\s+/g, " ");
}

export function dedupHash(
  accountId: string,
  row: { date: string; amountMinor: number; description: string },
): string {
  const key = [accountId, row.date, String(row.amountMinor), normalizeDescription(row.description)].join("|");
  return createHash("sha256").update(key).digest("hex");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && bun test src/lib/import/dedup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/import/dedup.ts apps/api/src/lib/import/dedup.test.ts
git commit -m "feat(import): content-based dedup hashing"
```

---

### Task 6: Detection (`detect.ts`)

**Files:**
- Create: `apps/api/src/lib/import/detect.ts`
- Test: `apps/api/src/lib/import/detect.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { expect, test } from "bun:test";
import { fingerprintCsv, matchParsers } from "./detect";

test("fingerprintCsv normalizes + sorts header columns", () => {
  const fp = fingerprintCsv("Date, Description ,Amount\nx,y,z", ",");
  expect(fp).toEqual({ format: "csv", delimiter: ",", headerColumns: ["amount", "date", "description"] });
});

test("matchParsers ranks by header overlap; exact set is confident", () => {
  const fp = fingerprintCsv("Date,Description,Amount\n", ",");
  const parsers = [
    { id: "p1", name: "DBS", fingerprint: { format: "csv" as const, delimiter: ",", headerColumns: ["amount", "date", "description"] } },
    { id: "p2", name: "Other", fingerprint: { format: "csv" as const, delimiter: ",", headerColumns: ["amount", "date"] } },
  ];
  const ranked = matchParsers(fp, parsers);
  expect(ranked[0]).toMatchObject({ parserId: "p1", confident: true });
  expect(ranked[0].score).toBe(1);
  expect(ranked[1].confident).toBe(false);
  expect(ranked[1].score).toBeLessThan(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun test src/lib/import/detect.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/api/src/lib/import/detect.ts`:

```typescript
import { parseDelimited } from "./csv";
import type { CsvFingerprint } from "./types";

export function fingerprintCsv(content: string, delimiter: string): CsvFingerprint {
  const rows = parseDelimited(content, delimiter);
  const header = (rows[0] ?? [])
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== "");
  return { format: "csv", delimiter, headerColumns: [...header].sort() };
}

export interface ParserCandidate {
  parserId: string;
  name: string;
  score: number;     // Jaccard similarity of header sets (0..1)
  confident: boolean;
}

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a), sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function matchParsers(
  fp: CsvFingerprint,
  parsers: Array<{ id: string; name: string; fingerprint: CsvFingerprint }>,
): ParserCandidate[] {
  return parsers
    .filter((p) => p.fingerprint.format === "csv")
    .map((p) => {
      const score = jaccard(fp.headerColumns, p.fingerprint.headerColumns);
      const confident = score === 1 && p.fingerprint.delimiter === fp.delimiter;
      return { parserId: p.id, name: p.name, score, confident };
    })
    .sort((a, b) => b.score - a.score);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && bun test src/lib/import/detect.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/import/detect.ts apps/api/src/lib/import/detect.test.ts
git commit -m "feat(import): CSV header fingerprint + parser matching"
```

---

### Task 7: Config validation (`validate.ts`)

**Files:**
- Create: `apps/api/src/lib/import/validate.ts`
- Test: `apps/api/src/lib/import/validate.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { expect, test } from "bun:test";
import { validateParserConfig } from "./validate";
import type { CsvParserConfig } from "./types";

const good: CsvParserConfig = {
  version: 1, format: "csv", csv: { delimiter: ",", headerRow: 0, skipRows: 0 },
  fields: {
    date: { column: "Date", format: "DD MMM YYYY" },
    description: { column: "Description" },
    amount: { mode: "single", column: "Amount", decimal: ".", thousands: ",", sign: "negativeIsDebit" },
  },
};

test("accepts a well-formed CSV config and returns it typed", () => {
  expect(validateParserConfig(good)).toEqual(good);
});

test("rejects malformed configs with a descriptive error", () => {
  expect(() => validateParserConfig(null)).toThrow("invalid_config");
  expect(() => validateParserConfig({ version: 1, format: "csv" })).toThrow("invalid_config");
  expect(() => validateParserConfig({ ...good, fields: { ...good.fields, amount: { mode: "bogus" } } })).toThrow("invalid_config");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun test src/lib/import/validate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/api/src/lib/import/validate.ts`:

```typescript
import type { CsvParserConfig, ParserConfig } from "./types";

function fail(): never { throw new Error("invalid_config"); }
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function str(v: unknown): string { if (typeof v !== "string") fail(); return v; }
function num(v: unknown): number { if (typeof v !== "number") fail(); return v; }

export function validateParserConfig(input: unknown): ParserConfig {
  if (!isObj(input)) fail();
  if (input.version !== 1) fail();
  if (input.format !== "csv") fail();

  const csv = input.csv;
  if (!isObj(csv)) fail();
  const csvBlock = { delimiter: str(csv.delimiter), headerRow: num(csv.headerRow), skipRows: num(csv.skipRows) };

  const fields = input.fields;
  if (!isObj(fields)) fail();
  const date = fields.date; if (!isObj(date)) fail();
  const description = fields.description; if (!isObj(description)) fail();
  const amount = fields.amount; if (!isObj(amount)) fail();

  let amountBlock: CsvParserConfig["fields"]["amount"];
  if (amount.mode === "single") {
    if (amount.sign !== "negativeIsDebit" && amount.sign !== "positiveIsDebit") fail();
    amountBlock = {
      mode: "single", column: str(amount.column),
      decimal: str(amount.decimal), thousands: str(amount.thousands), sign: amount.sign,
    };
  } else if (amount.mode === "debitCredit") {
    amountBlock = {
      mode: "debitCredit", debitColumn: str(amount.debitColumn), creditColumn: str(amount.creditColumn),
      decimal: str(amount.decimal), thousands: str(amount.thousands),
    };
  } else fail();

  const config: CsvParserConfig = {
    version: 1, format: "csv", csv: csvBlock,
    fields: {
      date: { column: str(date.column), format: str(date.format) },
      description: { column: str(description.column) },
      amount: amountBlock,
    },
  };
  if (isObj(input.rowFilter) && Array.isArray(input.rowFilter.dropIfBlank)) {
    const allowed = new Set(["date", "amount", "description"]);
    const drop = input.rowFilter.dropIfBlank.filter((f): f is "date" | "amount" | "description" =>
      typeof f === "string" && allowed.has(f));
    config.rowFilter = { dropIfBlank: drop };
  }
  return config;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && bun test src/lib/import/validate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/import/validate.ts apps/api/src/lib/import/validate.test.ts
git commit -m "feat(import): runtime parser-config validation"
```

---

### Task 8: Parser CRUD route (`import-parsers.ts`)

**Files:**
- Create: `apps/api/src/routes/import-parsers.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/src/routes/import-parsers.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { expect, test, beforeEach } from "bun:test";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { importParsersRoutes } from "./import-parsers";

beforeEach(resetDb);
const app = makeApp(importParsersRoutes);

const config = {
  version: 1, format: "csv", csv: { delimiter: ",", headerRow: 0, skipRows: 0 },
  fields: {
    date: { column: "Date", format: "DD MMM YYYY" },
    description: { column: "Description" },
    amount: { mode: "single", column: "Amount", decimal: ".", thousands: ",", sign: "negativeIsDebit" },
  },
};
const fingerprint = { format: "csv", delimiter: ",", headerColumns: ["amount", "date", "description"] };

test("create, list, patch, delete a parser", async () => {
  const { cookie } = await initAndLogin({ app });

  const created = await app.handle(new Request("http://localhost/import-parsers", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "DBS Statement Parser", sourceFormat: "csv", config, fingerprint }),
  }));
  expect(created.status).toBe(200);
  const { id } = await created.json();

  const list = await (await app.handle(new Request("http://localhost/import-parsers", { headers: { cookie } }))).json();
  expect(list.length).toBe(1);
  expect(list[0].name).toBe("DBS Statement Parser");
  expect(list[0].config.fields.amount.mode).toBe("single"); // returned parsed, not string

  const patched = await app.handle(new Request(`http://localhost/import-parsers/${id}`, {
    method: "PATCH", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "DBS (SGD)" }),
  }));
  expect(patched.status).toBe(200);

  await app.handle(new Request(`http://localhost/import-parsers/${id}`, { method: "DELETE", headers: { cookie } }));
  const after = await (await app.handle(new Request("http://localhost/import-parsers", { headers: { cookie } }))).json();
  expect(after.length).toBe(0);
});

test("rejects an invalid config with 422", async () => {
  const { cookie } = await initAndLogin({ app });
  const res = await app.handle(new Request("http://localhost/import-parsers", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Bad", sourceFormat: "csv", config: { version: 1, format: "csv" }, fingerprint }),
  }));
  expect(res.status).toBe(422);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun test src/routes/import-parsers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the route**

Create `apps/api/src/routes/import-parsers.ts`:

```typescript
import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { importParsers } from "../db/schema";
import { eq } from "drizzle-orm";
import { authGuard } from "../lib/auth-guard";
import { createId, nowEpoch } from "../lib/ids";
import { validateParserConfig } from "../lib/import/validate";

export const importParsersRoutes = new Elysia()
  .use(authGuard)
  .get("/import-parsers", async () => {
    const rows = await db.select().from(importParsers);
    return rows.map((r) => ({ ...r, config: JSON.parse(r.config), fingerprint: JSON.parse(r.fingerprint) }));
  })
  .post(
    "/import-parsers",
    async ({ body, userId, set }: any) => {
      try {
        validateParserConfig(body.config);
      } catch {
        set.status = 422; return { error: "invalid_config" };
      }
      const id = body.id ?? createId();
      await db.insert(importParsers).values({
        id, name: body.name, sourceFormat: body.sourceFormat,
        config: JSON.stringify(body.config), fingerprint: JSON.stringify(body.fingerprint),
        origin: body.origin ?? "manual", createdAt: nowEpoch(), createdBy: userId!,
      });
      return { id };
    },
    {
      body: t.Object({
        id: t.Optional(t.String()),
        name: t.String(),
        sourceFormat: t.Union([t.Literal("csv"), t.Literal("ofx"), t.Literal("qif"), t.Literal("pdf")]),
        config: t.Unknown(),
        fingerprint: t.Unknown(),
        origin: t.Optional(t.Union([t.Literal("ai"), t.Literal("manual")])),
      }),
    },
  )
  .patch(
    "/import-parsers/:id",
    async ({ params, body, set }: any) => {
      const update: Record<string, unknown> = {};
      if (body.name !== undefined) update.name = body.name;
      if (body.config !== undefined) {
        try { validateParserConfig(body.config); } catch { set.status = 422; return { error: "invalid_config" }; }
        update.config = JSON.stringify(body.config);
      }
      if (body.fingerprint !== undefined) update.fingerprint = JSON.stringify(body.fingerprint);
      await db.update(importParsers).set(update).where(eq(importParsers.id, params.id));
      return { ok: true };
    },
    { body: t.Object({ name: t.Optional(t.String()), config: t.Optional(t.Unknown()), fingerprint: t.Optional(t.Unknown()) }) },
  )
  .delete("/import-parsers/:id", async ({ params }) => {
    await db.delete(importParsers).where(eq(importParsers.id, params.id));
    return { ok: true };
  });
```

- [ ] **Step 4: Register the route**

In `apps/api/src/app.ts`, add the import and `.use()` call inside `createApiApp()` (after `transactionsRoutes`):

```typescript
import { importParsersRoutes } from "./routes/import-parsers";
```
```typescript
    .use(transactionsRoutes)
    .use(importParsersRoutes)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/api && bun test src/routes/import-parsers.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/import-parsers.ts apps/api/src/routes/import-parsers.test.ts apps/api/src/app.ts
git commit -m "feat(import): parser CRUD route"
```

---

### Task 9: Imports route — detect + parse-to-batch (`imports.ts`)

**Files:**
- Create: `apps/api/src/routes/imports.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/src/routes/imports.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { expect, test, beforeEach } from "bun:test";
import { db } from "../db/client";
import { accounts, importParsers, importBatches, importRows } from "../db/schema";
import { eq } from "drizzle-orm";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { createId, nowEpoch } from "../lib/ids";
import { importParsersRoutes } from "./import-parsers";
import { importsRoutes } from "./imports";

beforeEach(resetDb);
const app = makeApp(importParsersRoutes, importsRoutes);

const config = {
  version: 1, format: "csv", csv: { delimiter: ",", headerRow: 0, skipRows: 0 },
  fields: {
    date: { column: "Date", format: "YYYY-MM-DD" },
    description: { column: "Description" },
    amount: { mode: "single", column: "Amount", decimal: ".", thousands: ",", sign: "negativeIsDebit" },
  },
};
const fingerprint = { format: "csv", delimiter: ",", headerColumns: ["amount", "date", "description"] };
const CSV = "Date,Description,Amount\n2026-02-01,COFFEE,-4.50\n2026-02-02,SALARY,2500.00";

async function seedAccount(currency = "USD") {
  const id = createId();
  await db.insert(accounts).values({
    id, name: "Checking", class: "asset", subtype: "cash", currency,
    isArchived: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy: "u",
    growthRateBps: 0, accessibleFromAge: 0, earlyWithdrawal: "none",
    earlyHaircutBps: 0, illiquid: 0, liquidationAge: null,
  });
  return id;
}
async function seedParser(cookie: string) {
  const res = await app.handle(new Request("http://localhost/import-parsers", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Test CSV", sourceFormat: "csv", config, fingerprint }),
  }));
  return (await res.json()).id as string;
}

test("detect suggests a matching parser", async () => {
  const { cookie } = await initAndLogin({ app });
  await seedParser(cookie);
  const res = await app.handle(new Request("http://localhost/imports/detect", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ filename: "feb.csv", content: CSV }),
  }));
  const { candidates } = await res.json();
  expect(candidates[0].confident).toBe(true);
});

test("parse stages rows with dedup status and counts", async () => {
  const { cookie } = await initAndLogin({ app });
  const acc = await seedAccount();
  const parserId = await seedParser(cookie);

  const res = await app.handle(new Request(`http://localhost/accounts/${acc}/imports`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ filename: "feb.csv", content: CSV, parserId }),
  }));
  expect(res.status).toBe(200);
  const batch = await res.json();
  expect(batch.rowCountNew).toBe(2);
  expect(batch.rows.length).toBe(2);
  expect(batch.rows.find((r: any) => r.description === "COFFEE").amountMinor).toBe(-450);

  // re-import the same file -> all duplicates (against the prior staged? no — against committed.
  // Here nothing committed yet, so still "new". Within-batch dup is covered below.)
  const dupCsv = "Date,Description,Amount\n2026-02-01,COFFEE,-4.50\n2026-02-01,COFFEE,-4.50";
  const res2 = await app.handle(new Request(`http://localhost/accounts/${acc}/imports`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ filename: "dup.csv", content: dupCsv, parserId }),
  }));
  const batch2 = await res2.json();
  expect(batch2.rowCountNew).toBe(1);
  expect(batch2.rowCountDuplicate).toBe(1); // second identical row flagged within-batch
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun test src/routes/imports.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement detect + parse**

Create `apps/api/src/routes/imports.ts`:

```typescript
import { Elysia, t } from "elysia";
import { createHash } from "node:crypto";
import { db } from "../db/client";
import { accounts, importParsers, importBatches, importRows, transactions } from "../db/schema";
import { and, eq } from "drizzle-orm";
import { authGuard } from "../lib/auth-guard";
import { createId, nowEpoch } from "../lib/ids";
import { ensureCurrencyInstrument } from "../lib/instruments";
import { parseCsv } from "../lib/import/csv";
import { fingerprintCsv, matchParsers } from "../lib/import/detect";
import { dedupHash } from "../lib/import/dedup";
import { unitsDeltaToAmountMinor } from "../lib/import/amount";
import { validateParserConfig } from "../lib/import/validate";
import type { CsvFingerprint } from "../lib/import/types";

const fileHashOf = (s: string) => createHash("sha256").update(s).digest("hex");

export const importsRoutes = new Elysia()
  .use(authGuard)
  // ---- detect: rank saved parsers against an uploaded file ----
  .post(
    "/imports/detect",
    async ({ body }: any) => {
      const fp = fingerprintCsv(body.content, ",");
      const parsers = await db.select().from(importParsers).where(eq(importParsers.sourceFormat, "csv"));
      const candidates = matchParsers(
        fp,
        parsers.map((p) => ({ id: p.id, name: p.name, fingerprint: JSON.parse(p.fingerprint) as CsvFingerprint })),
      );
      return { fingerprint: fp, candidates };
    },
    { body: t.Object({ filename: t.String(), content: t.String() }) },
  )
  // ---- parse a file into a staged batch ----
  .post(
    "/accounts/:id/imports",
    async ({ params, body, userId, set }: any) => {
      const [account] = await db.select().from(accounts).where(eq(accounts.id, params.id));
      if (!account) { set.status = 404; return { error: "unknown_account" }; }
      const [parser] = await db.select().from(importParsers).where(eq(importParsers.id, body.parserId));
      if (!parser) { set.status = 422; return { error: "unknown_parser" }; }

      const config = validateParserConfig(JSON.parse(parser.config));
      const canonical = parseCsv(body.content, config, account.currency);

      // Build the set of dedup hashes for already-committed cash transactions.
      const cashInstrumentId = await ensureCurrencyInstrument(account.currency);
      const existing = await db.select().from(transactions)
        .where(and(eq(transactions.accountId, params.id), eq(transactions.instrumentId, cashInstrumentId)));
      const seen = new Set<string>();
      for (const t of existing) {
        const amountMinor = unitsDeltaToAmountMinor(t.unitsDelta, account.currency);
        seen.add(dedupHash(params.id, { date: t.date, amountMinor, description: t.notes ?? "" }));
      }

      const batchId = createId();
      const now = nowEpoch();
      let nNew = 0, nDup = 0, nErr = 0;
      const rowValues = canonical.map((row) => {
        let status: "new" | "duplicate" | "error";
        let hash = "";
        if (row.error || row.date === null || row.amountMinor === null) {
          status = "error"; nErr++;
        } else {
          hash = dedupHash(params.id, { date: row.date, amountMinor: row.amountMinor, description: row.description });
          if (seen.has(hash)) { status = "duplicate"; nDup++; }
          else { seen.add(hash); status = "new"; nNew++; }
        }
        return {
          id: createId(), batchId, raw: JSON.stringify(row.raw),
          date: row.date, amountMinor: row.amountMinor, description: row.description,
          category: null, dedupHash: hash, status, errorReason: row.error ?? null,
          matchedTxnId: null, committedTxnId: null,
        };
      });

      await db.insert(importBatches).values({
        id: batchId, parserId: parser.id, accountId: params.id, filename: body.filename,
        fileHash: fileHashOf(body.content), status: "review",
        rowCountNew: nNew, rowCountDuplicate: nDup, rowCountError: nErr,
        createdAt: now, createdBy: userId!,
      });
      if (rowValues.length > 0) await db.insert(importRows).values(rowValues);

      const rows = await db.select().from(importRows).where(eq(importRows.batchId, batchId));
      return { id: batchId, accountId: params.id, filename: body.filename,
        status: "review", rowCountNew: nNew, rowCountDuplicate: nDup, rowCountError: nErr, rows };
    },
    { body: t.Object({ filename: t.String(), content: t.String(), parserId: t.String() }) },
  );
```

- [ ] **Step 4: Register the route**

In `apps/api/src/app.ts`, add:

```typescript
import { importsRoutes } from "./routes/imports";
```
```typescript
    .use(importParsersRoutes)
    .use(importsRoutes)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/api && bun test src/routes/imports.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/imports.ts apps/api/src/routes/imports.test.ts apps/api/src/app.ts
git commit -m "feat(import): detect + parse-to-staged-batch route"
```

---

### Task 10: Get batch + edit staged row

**Files:**
- Modify: `apps/api/src/routes/imports.ts`
- Modify: `apps/api/src/routes/imports.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `apps/api/src/routes/imports.test.ts`:

```typescript
test("GET batch returns batch + rows; PATCH row edits and toggles status", async () => {
  const { cookie } = await initAndLogin({ app });
  const acc = await seedAccount();
  const parserId = await seedParser(cookie);
  const created = await (await app.handle(new Request(`http://localhost/accounts/${acc}/imports`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ filename: "feb.csv", content: CSV, parserId }),
  }))).json();

  const got = await (await app.handle(new Request(`http://localhost/imports/${created.id}`, { headers: { cookie } }))).json();
  expect(got.rows.length).toBe(2);

  const rowId = got.rows[0].id;
  const patched = await app.handle(new Request(`http://localhost/import-rows/${rowId}`, {
    method: "PATCH", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ status: "excluded", description: "edited" }),
  }));
  expect(patched.status).toBe(200);
  const after = await db.select().from(importRows).where(eq(importRows.id, rowId));
  expect(after[0].status).toBe("excluded");
  expect(after[0].description).toBe("edited");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun test src/routes/imports.test.ts`
Expected: FAIL — `/imports/:batchId` and `/import-rows/:id` routes don't exist (404).

- [ ] **Step 3: Implement**

In `apps/api/src/routes/imports.ts`, chain these before the final `;`:

```typescript
  .get("/imports/:id", async ({ params, set }: any) => {
    const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, params.id));
    if (!batch) { set.status = 404; return { error: "unknown_batch" }; }
    const rows = await db.select().from(importRows).where(eq(importRows.batchId, params.id));
    return { ...batch, rows };
  })
  .patch(
    "/import-rows/:id",
    async ({ params, body }: any) => {
      const update: Record<string, unknown> = {};
      if (body.status !== undefined) update.status = body.status;
      if (body.date !== undefined) update.date = body.date;
      if (body.amountMinor !== undefined) update.amountMinor = body.amountMinor;
      if (body.description !== undefined) update.description = body.description;
      await db.update(importRows).set(update).where(eq(importRows.id, params.id));
      return { ok: true };
    },
    {
      body: t.Object({
        status: t.Optional(t.Union([t.Literal("new"), t.Literal("duplicate"), t.Literal("excluded"), t.Literal("error")])),
        date: t.Optional(t.String()),
        amountMinor: t.Optional(t.Number()),
        description: t.Optional(t.String()),
      }),
    },
  )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && bun test src/routes/imports.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/imports.ts apps/api/src/routes/imports.test.ts
git commit -m "feat(import): get batch + edit staged row"
```

---

### Task 11: Commit + discard a batch

**Files:**
- Modify: `apps/api/src/routes/imports.ts`
- Modify: `apps/api/src/routes/imports.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `apps/api/src/routes/imports.test.ts`:

```typescript
import { SCALE } from "@uang/shared";
const S = Number(SCALE);

test("commit inserts only 'new' rows as cash transactions and marks the batch committed", async () => {
  const { cookie } = await initAndLogin({ app });
  const acc = await seedAccount();
  const parserId = await seedParser(cookie);
  const created = await (await app.handle(new Request(`http://localhost/accounts/${acc}/imports`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ filename: "feb.csv", content: CSV, parserId }),
  }))).json();

  // exclude the COFFEE row; only SALARY should commit
  const coffee = created.rows.find((r: any) => r.description === "COFFEE");
  await app.handle(new Request(`http://localhost/import-rows/${coffee.id}`, {
    method: "PATCH", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ status: "excluded" }),
  }));

  const res = await app.handle(new Request(`http://localhost/imports/${created.id}/commit`, {
    method: "POST", headers: { cookie },
  }));
  expect(res.status).toBe(200);
  const result = await res.json();
  expect(result.committed).toBe(1);

  const txns = await db.select().from(transactions).where(eq(transactions.accountId, acc));
  expect(txns.length).toBe(1);
  expect(txns[0].unitsDelta).toBe(2500 * S);     // +$2500 salary
  expect(txns[0].notes).toBe("SALARY");
  expect(txns[0].importBatchId).toBe(created.id);

  const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, created.id));
  expect(batch.status).toBe("committed");
});

test("committed rows dedup against a second import", async () => {
  const { cookie } = await initAndLogin({ app });
  const acc = await seedAccount();
  const parserId = await seedParser(cookie);
  const first = await (await app.handle(new Request(`http://localhost/accounts/${acc}/imports`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ filename: "feb.csv", content: CSV, parserId }),
  }))).json();
  await app.handle(new Request(`http://localhost/imports/${first.id}/commit`, { method: "POST", headers: { cookie } }));

  const second = await (await app.handle(new Request(`http://localhost/accounts/${acc}/imports`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ filename: "feb-again.csv", content: CSV, parserId }),
  }))).json();
  expect(second.rowCountDuplicate).toBe(2);
  expect(second.rowCountNew).toBe(0);
});

test("discard deletes the batch and its rows", async () => {
  const { cookie } = await initAndLogin({ app });
  const acc = await seedAccount();
  const parserId = await seedParser(cookie);
  const created = await (await app.handle(new Request(`http://localhost/accounts/${acc}/imports`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ filename: "feb.csv", content: CSV, parserId }),
  }))).json();
  const res = await app.handle(new Request(`http://localhost/imports/${created.id}`, { method: "DELETE", headers: { cookie } }));
  expect(res.status).toBe(200);
  const rows = await db.select().from(importRows).where(eq(importRows.batchId, created.id));
  expect(rows.length).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun test src/routes/imports.test.ts`
Expected: FAIL — commit/discard routes don't exist.

- [ ] **Step 3: Implement**

Add the imports at the top of `apps/api/src/routes/imports.ts`:

```typescript
import { amountMinorToUnitsDelta } from "../lib/import/amount";
import { SCALE } from "@uang/shared";
```

Then chain these onto the route plugin (before the final `;`):

```typescript
  .post("/imports/:id/commit", async ({ params, userId, set }: any) => {
    const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, params.id));
    if (!batch) { set.status = 404; return { error: "unknown_batch" }; }
    if (batch.status === "committed") { set.status = 409; return { error: "already_committed" }; }
    const [account] = await db.select().from(accounts).where(eq(accounts.id, batch.accountId));
    if (!account) { set.status = 404; return { error: "unknown_account" }; }

    const cashInstrumentId = await ensureCurrencyInstrument(account.currency);
    const rows = await db.select().from(importRows)
      .where(and(eq(importRows.batchId, params.id), eq(importRows.status, "new")));

    const now = nowEpoch();
    let committed = 0;
    for (const row of rows) {
      if (row.date === null || row.amountMinor === null) continue;
      const txnId = createId();
      await db.insert(transactions).values({
        id: txnId, accountId: batch.accountId, instrumentId: cashInstrumentId,
        date: row.date, unitsDelta: amountMinorToUnitsDelta(row.amountMinor, account.currency),
        unitPriceScaled: Number(SCALE), feesMinor: 0, notes: row.description,
        importBatchId: batch.id, createdAt: now, createdBy: userId!,
      });
      await db.update(importRows).set({ committedTxnId: txnId }).where(eq(importRows.id, row.id));
      committed++;
    }
    await db.update(importBatches).set({ status: "committed" }).where(eq(importBatches.id, params.id));
    return { committed };
  })
  .delete("/imports/:id", async ({ params }) => {
    await db.delete(importRows).where(eq(importRows.batchId, params.id));
    await db.delete(importBatches).where(eq(importBatches.id, params.id));
    return { ok: true };
  })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && bun test src/routes/imports.test.ts`
Expected: PASS (6 tests total in the file).

- [ ] **Step 5: Full API test sweep + typecheck**

Run: `cd apps/api && bun test`
Expected: all tests PASS.
Run: `cd apps/web && bun run build`
Expected: build succeeds (Eden `App` type now includes the new routes; no type errors).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/imports.ts apps/api/src/routes/imports.test.ts
git commit -m "feat(import): commit staged rows to transactions + discard batch"
```

---

### Task 12: shadcn primitives for the UI

**Files:**
- Create (via CLI): `apps/web/src/components/ui/table.tsx`, `apps/web/src/components/ui/checkbox.tsx`

- [ ] **Step 1: Add the components via the shadcn CLI** (project rule: always use the CLI)

Run: `cd apps/web && bunx shadcn@latest add table checkbox`
Expected: creates `components/ui/table.tsx` and `components/ui/checkbox.tsx`. If prompted, accept defaults.

- [ ] **Step 2: Verify the build still passes**

Run: `cd apps/web && bun run build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ui/table.tsx apps/web/src/components/ui/checkbox.tsx apps/web/package.json
git commit -m "chore(web): add shadcn table + checkbox for import UI"
```

---

### Task 13: Import dialog (upload → detect → parse)

**Files:**
- Create: `apps/web/src/components/import-dialog.tsx`

This dialog: reads a CSV file as text, calls `/imports/detect`, lets the user pick a suggested parser **or** create a quick manual parser (map Date/Description/Amount columns), then POSTs to `/accounts/:id/imports` and hands the resulting batch to the review screen (Task 14).

- [ ] **Step 1: Implement the dialog**

Create `apps/web/src/components/import-dialog.tsx`:

```typescript
import { useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ImportReview } from "@/components/import-review";

type Candidate = { parserId: string; name: string; score: number; confident: boolean };
type Detect = { fingerprint: { headerColumns: string[] }; candidates: Candidate[] };

const NEW_PARSER = "__new__";

export function ImportDialog({ accountId, accountCurrency }: { accountId: string; accountCurrency: string }) {
  const [open, setOpen] = useState(false);
  const [filename, setFilename] = useState("");
  const [content, setContent] = useState("");
  const [detect, setDetect] = useState<Detect | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [parserId, setParserId] = useState<string>("");
  const [batchId, setBatchId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // New-parser column mapping fields
  const [name, setName] = useState("");
  const [dateCol, setDateCol] = useState("");
  const [dateFmt, setDateFmt] = useState("YYYY-MM-DD");
  const [descCol, setDescCol] = useState("");
  const [amountCol, setAmountCol] = useState("");
  const [sign, setSign] = useState<"negativeIsDebit" | "positiveIsDebit">("negativeIsDebit");

  function reset() {
    setFilename(""); setContent(""); setDetect(null); setHeaders([]); setParserId("");
    setBatchId(null); setName(""); setDateCol(""); setDescCol(""); setAmountCol("");
    setDateFmt("YYYY-MM-DD"); setSign("negativeIsDebit");
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setFilename(file.name); setContent(text);
    const firstLine = text.split(/\r?\n/)[0] ?? "";
    setHeaders(firstLine.split(",").map((h) => h.trim()).filter(Boolean));
    const { data } = await api.imports.detect.post({ filename: file.name, content: text });
    if (data && "candidates" in data) {
      setDetect(data);
      const top = data.candidates.find((c) => c.confident) ?? data.candidates[0];
      setParserId(top ? top.parserId : NEW_PARSER);
    } else {
      setParserId(NEW_PARSER);
    }
  }

  function buildConfig() {
    return {
      version: 1 as const, format: "csv" as const,
      csv: { delimiter: ",", headerRow: 0, skipRows: 0 },
      fields: {
        date: { column: dateCol, format: dateFmt },
        description: { column: descCol },
        amount: { mode: "single" as const, column: amountCol, decimal: ".", thousands: ",", sign },
      },
      rowFilter: { dropIfBlank: ["date" as const, "amount" as const] },
    };
  }

  async function run() {
    setBusy(true);
    try {
      let useParserId = parserId;
      if (parserId === NEW_PARSER) {
        const fingerprint = { format: "csv", delimiter: ",", headerColumns: [...headers].map((h) => h.toLowerCase()).sort() };
        const { data, error } = await api["import-parsers"].post({
          name: name || filename, sourceFormat: "csv", config: buildConfig(), fingerprint, origin: "manual",
        });
        if (error || !data || !("id" in data)) throw new Error(String(error ?? "parser create failed"));
        useParserId = data.id;
      }
      const { data, error } = await api.accounts({ id: accountId }).imports.post({ filename, content, parserId: useParserId });
      if (error || !data || !("id" in data)) throw new Error(String(error ?? "import failed"));
      setBatchId(data.id);
    } finally {
      setBusy(false);
    }
  }

  const needsMapping = parserId === NEW_PARSER;
  const canRun = content !== "" && (!needsMapping || (dateCol && descCol && amountCol));

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger asChild>
        <Button variant="outline">Import statement</Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader><DialogTitle>Import statement (CSV)</DialogTitle></DialogHeader>

        {batchId ? (
          <ImportReview batchId={batchId} accountCurrency={accountCurrency} onDone={() => { setOpen(false); reset(); }} />
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>CSV file</Label>
              <Input type="file" accept=".csv,text/csv" data-testid="import-file" onChange={onFile} />
            </div>

            {content && (
              <div className="space-y-2">
                <Label>Parser</Label>
                <Select value={parserId} onValueChange={setParserId}>
                  <SelectTrigger data-testid="import-parser"><SelectValue placeholder="Choose a parser" /></SelectTrigger>
                  <SelectContent>
                    {detect?.candidates.map((c) => (
                      <SelectItem key={c.parserId} value={c.parserId}>
                        {c.name}{c.confident ? " (match)" : ` (${Math.round(c.score * 100)}%)`}
                      </SelectItem>
                    ))}
                    <SelectItem value={NEW_PARSER}>Create a new parser…</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {needsMapping && (
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2 space-y-1">
                  <Label>Parser name</Label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={filename} data-testid="parser-name" />
                </div>
                <ColumnPick label="Date column" value={dateCol} set={setDateCol} headers={headers} testId="map-date" />
                <div className="space-y-1">
                  <Label>Date format</Label>
                  <Input value={dateFmt} onChange={(e) => setDateFmt(e.target.value)} data-testid="map-dateformat" />
                </div>
                <ColumnPick label="Description column" value={descCol} set={setDescCol} headers={headers} testId="map-desc" />
                <ColumnPick label="Amount column" value={amountCol} set={setAmountCol} headers={headers} testId="map-amount" />
                <div className="space-y-1">
                  <Label>Amount sign</Label>
                  <Select value={sign} onValueChange={(v) => setSign(v as typeof sign)}>
                    <SelectTrigger data-testid="map-sign"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="negativeIsDebit">Negative = money out</SelectItem>
                      <SelectItem value="positiveIsDebit">Positive = money out</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            <DialogFooter>
              <Button onClick={run} disabled={!canRun || busy} data-testid="import-run">
                {busy ? "Parsing…" : "Parse & review"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ColumnPick({ label, value, set, headers, testId }: {
  label: string; value: string; set: (v: string) => void; headers: string[]; testId: string;
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Select value={value} onValueChange={set}>
        <SelectTrigger data-testid={testId}><SelectValue placeholder="Select column" /></SelectTrigger>
        <SelectContent>
          {headers.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}
```

> **Note:** `api["import-parsers"]` is the Eden accessor for the hyphenated path. If TypeScript prefers `api.importParsers`, use whichever the generated `App` type exposes — confirm at build time.

- [ ] **Step 2: Build (will fail until Task 14 creates ImportReview)**

This task imports `ImportReview`, created next. Proceed to Task 14, then build both together.

- [ ] **Step 3: Commit (after Task 14 build passes)** — see Task 14.

---

### Task 14: Import review table + commit

**Files:**
- Create: `apps/web/src/components/import-review.tsx`

- [ ] **Step 1: Implement the review screen**

Create `apps/web/src/components/import-review.tsx`:

```typescript
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { currencyDecimals } from "@uang/shared";
import { api } from "@/lib/api";
import { transactionsCollection } from "@/lib/collections";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

type Row = {
  id: string; date: string | null; amountMinor: number | null;
  description: string; status: "new" | "duplicate" | "excluded" | "error"; errorReason: string | null;
};
type Batch = { id: string; accountId: string; rows: Row[] };

function fmt(minor: number | null, currency: string): string {
  if (minor === null) return "—";
  return (minor / 10 ** currencyDecimals(currency)).toLocaleString(undefined, {
    minimumFractionDigits: currencyDecimals(currency), maximumFractionDigits: currencyDecimals(currency),
  });
}

export function ImportReview({ batchId, accountCurrency, onDone }: {
  batchId: string; accountCurrency: string; onDone: () => void;
}) {
  const qc = useQueryClient();
  const [batch, setBatch] = useState<Batch | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.imports({ id: batchId }).get().then(({ data }) => {
      if (!cancelled && data && "rows" in data) setBatch(data as Batch);
    });
    return () => { cancelled = true; };
  }, [batchId]);

  if (!batch) return <div className="py-8 text-center text-muted-foreground">Loading…</div>;

  async function toggle(row: Row, include: boolean) {
    const status = include ? "new" : "excluded";
    await api["import-rows"]({ id: row.id }).patch({ status });
    setBatch((b) => b && { ...b, rows: b.rows.map((r) => r.id === row.id ? { ...r, status } : r) });
  }

  async function commit() {
    setBusy(true);
    try {
      const { error } = await api.imports({ id: batchId }).commit.post();
      if (error) throw new Error(String(error));
      await transactionsCollection(batch!.accountId).utils.refetch();
      await qc.invalidateQueries({ queryKey: ["accounts"] });
      onDone();
    } finally {
      setBusy(false);
    }
  }

  const includable = batch.rows.filter((r) => r.status === "new").length;
  const dupes = batch.rows.filter((r) => r.status === "duplicate").length;
  const errors = batch.rows.filter((r) => r.status === "error").length;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {includable} to import · {dupes} duplicates skipped · {errors} errors
      </p>
      <div className="max-h-[50vh] overflow-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10" />
              <TableHead>Date</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {batch.rows.map((r) => (
              <TableRow key={r.id} data-testid="import-row">
                <TableCell>
                  <Checkbox
                    checked={r.status === "new"}
                    disabled={r.status === "error" || r.status === "duplicate"}
                    onCheckedChange={(v) => toggle(r, v === true)}
                    data-testid="import-row-include"
                  />
                </TableCell>
                <TableCell>{r.date ?? "—"}</TableCell>
                <TableCell>{r.description}</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(r.amountMinor, accountCurrency)}</TableCell>
                <TableCell className="text-muted-foreground">{r.errorReason ?? r.status}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>Cancel</Button>
        <Button onClick={commit} disabled={busy || includable === 0} data-testid="import-commit">
          {busy ? "Importing…" : `Import ${includable}`}
        </Button>
      </div>
    </div>
  );
}
```

> **Note:** Confirm the Eden accessors at build time: hyphenated paths surface as `api["import-rows"]` / `api["import-parsers"]`; `api.imports({ id }).commit.post()` and `api.imports({ id }).get()` follow the existing `api.accounts({ id })...` pattern. Adjust to match the generated `App` type if the build complains.

- [ ] **Step 2: Build both new components**

Run: `cd apps/web && bun run build`
Expected: success. Fix any Eden accessor mismatches flagged by tsgo (see notes in Tasks 13–14). **No `as any`** — if a response union needs narrowing, check `"rows" in data` / `"id" in data` as shown.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/import-dialog.tsx apps/web/src/components/import-review.tsx
git commit -m "feat(web): import dialog + review/commit UI"
```

---

### Task 15: Wire the entry point + e2e happy path

**Files:**
- Modify: `apps/web/src/routes/account-detail.tsx`
- Create: `e2e/tests/import.spec.ts`

- [ ] **Step 1: Add the Import button next to Add transaction**

In `apps/web/src/routes/account-detail.tsx`, add the import near the existing `AddTransactionDialog` import:

```typescript
import { ImportDialog } from "@/components/import-dialog";
```

Find the line rendering `<AddTransactionDialog accountId={id} accountCurrency={account.currency} />` (around line 168) and render the import dialog beside it:

```typescript
        <div className="flex gap-2">
          <AddTransactionDialog accountId={id} accountCurrency={account.currency} />
          <ImportDialog accountId={id} accountCurrency={account.currency} />
        </div>
```

(If `AddTransactionDialog` is already inside a flex container, just add `<ImportDialog ... />` after it rather than introducing a new wrapper.)

- [ ] **Step 2: Build**

Run: `cd apps/web && bun run build`
Expected: success.

- [ ] **Step 3: Write the e2e happy-path test**

Create `e2e/tests/import.spec.ts`:

```typescript
import { test, expect } from "./fixtures";
import { seedHousehold, createAccount, ADMIN } from "./helpers";

const CSV = "Date,Description,Amount\n2026-02-01,COFFEE BEAN,-4.50\n2026-02-02,SALARY,2500.00\n";

test.beforeEach(async ({ backend, request, context }) => {
  await backend.freshDb();
  await seedHousehold(request, context, backend.apiURL);
});

test("import a CSV statement into an account", async ({ page }) => {
  await page.goto("/");
  await createAccount(page, { name: "Checking", currency: "USD" });

  await page.getByTestId("account-row").filter({ hasText: "Checking" }).click();
  await expect(page).toHaveURL(/\/accounts\//);

  await page.getByRole("button", { name: "Import statement" }).click();
  const dialog = page.getByRole("dialog");

  // Upload the CSV from an in-memory buffer.
  await dialog.getByTestId("import-file").setInputFiles({
    name: "feb.csv", mimeType: "text/csv", buffer: Buffer.from(CSV),
  });

  // No saved parser yet -> the Select defaults to "Create a new parser…".
  await dialog.getByTestId("map-date").click();
  await page.getByRole("option", { name: "Date" }).click();
  await dialog.getByTestId("map-dateformat").fill("YYYY-MM-DD");
  await dialog.getByTestId("map-desc").click();
  await page.getByRole("option", { name: "Description" }).click();
  await dialog.getByTestId("map-amount").click();
  await page.getByRole("option", { name: "Amount" }).click();

  await dialog.getByTestId("import-run").click();

  // Review screen shows 2 rows; commit them.
  await expect(dialog.getByTestId("import-row")).toHaveCount(2);
  await dialog.getByTestId("import-commit").click();
  await expect(dialog).toBeHidden();

  // The two transactions now appear in the account history.
  await expect(page.getByText("SALARY")).toBeVisible();
  await expect(page.getByText("COFFEE BEAN")).toBeVisible();
});
```

- [ ] **Step 4: Run the e2e test**

Run: `cd e2e && bun run test --grep "import a CSV statement"`
Expected: PASS. If selectors differ (e.g. the account history renders descriptions differently), adjust the final assertions to match how `account-history.tsx` displays `notes`.

- [ ] **Step 5: Full sweep**

Run: `cd apps/api && bun test` → all PASS.
Run: `cd apps/web && bun run build` → success.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/account-detail.tsx e2e/tests/import.spec.ts
git commit -m "feat(web): wire import entry point + e2e happy path"
```

---

## Self-Review

**Spec coverage** (against `2026-06-15-external-data-import-design.md`, Spec 1 scope):
- Spine (upload→fingerprint→detect→parse→stage→review→commit): Tasks 9–11, 13–15. ✓
- `import_parsers` / `import_batches` / `import_rows` + `transactions.importBatchId`: Task 1. ✓
- Declarative CSV config + human-editable: Tasks 4, 7 (validation), 13 (manual mapping UI). ✓
- Detection suggest-and-confirm (B): Tasks 6, 9 (detect endpoint), 13 (suggested-parser Select). ✓
- Dedup (content hash; FITID is Spec 2): Tasks 5, 9 (within-batch + vs committed), 11 (post-commit). ✓
- Ledger-only commit on currency instrument, category seam reserved: Task 1 (`category` column), Task 11 (commit). ✓
- AI explicitly out of scope this spec: no AI code present. ✓ (Spec 3.)
- Fixture-driven pure-function tests + typecheck via web build: Tasks 2–7 (pure), Task 11/15 (build). ✓

**Out of scope here (correctly deferred):** OFX/QIF (Spec 2), AI synthesis + provider adapters (Spec 3), PDF (Spec 4), brokerage/instrument resolution + cash legs (Spec 5), the "auto-apply confident matches" settings toggle (small follow-up; default is suggest-and-confirm), parser export/share.

**Placeholder scan:** none — every code/test/command step is concrete. The two "confirm Eden accessor at build time" notes are not placeholders; the hyphenated-path access (`api["import-parsers"]`) is a known Eden behavior and the build verifies it.

**Type consistency:** `CanonicalRow`/`CsvParserConfig`/`CsvFingerprint` defined in Task 4 are used unchanged in Tasks 5–9, 13. `parseCsv(content, config, currency)` (3-arg, after the Task 4 simplification) is called consistently in Task 9. `amountMinorToUnitsDelta` / `unitsDeltaToAmountMinor` (Task 3) used in Task 9 (dedup) and Task 11 (commit). Row statuses `new|duplicate|excluded|error` consistent across schema (Task 1), route (Tasks 9–11), and UI (Task 14).

**Known follow-up risk:** the `dropIfBlank` all-blank-row test relies on the row being filtered before the error check; verified by the Task 4 test. The e2e selector assertions (Task 15) may need tuning to the actual `account-history.tsx` markup — called out in-step.
