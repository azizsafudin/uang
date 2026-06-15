# Text-PDF Parsing + AI Synthesis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deterministically import text-bearing PDF bank/credit-card statements by synthesizing a reusable declarative parser (once per format), reusing the Spec 1 staging/dedup/commit pipeline and the Spec 3 AI substrate.

**Architecture:** A new server-side text-extraction front-step (`unpdf`) turns PDF bytes into text at upload time; the client then reuses the **existing text-based** synthesize/refine/preview/import flow, passing the extracted text as `content` with `format: "pdf"`. A new `PdfParserConfig` (Tier 1: line-regex + region anchors + multiline continuation) is run by a deterministic `runPdfParser` engine that reuses Spec 1's `parseDate` and `parseAmountToMinor`. Detection uses marker-overlap fingerprints. Downstream staging/dedup/review/commit are unchanged.

**Tech Stack:** Bun, Elysia, Drizzle/libsql, `unpdf` (pdf.js-based, zero native deps), React + Eden treaty, Playwright.

**Resolved decisions (from the spec's Open Decisions):**
- **A — PDF library:** `unpdf@1.6.2`. Empirically verified under Bun: `extractText(bytes, { mergePages: false })` returns per-page text. **Positioned items (`getTextContent`) throw `DataCloneError` under Bun** — so positioned-column rules are not viable on this stack.
- **B — rule vocabulary:** **Tier 1 only** (line-regex + region + multiline). Tier 2 (positioned columns) is deferred — it cannot run on Bun today.
- **C — transport:** **Extract once, reuse the text path.** New `POST /imports/extract` takes base64 PDF bytes → returns `{ text, fingerprint, candidates }`. Client holds the text and reuses the existing `content`-based endpoints with `format: "pdf"`.

**Type-safety rule (CLAUDE.md):** never use `as any`. The one tolerated `any` is Elysia route-handler context destructuring (`async ({ body, set }: any) =>`), matching existing routes. Narrow union configs by checking `config.format`.

---

## File Structure

**Create:**
- `apps/api/src/lib/import/pdf.ts` — `runPdfParser(text, config, currency)` rule engine.
- `apps/api/src/lib/import/pdf.test.ts` — engine unit tests over plain-text fixtures.
- `apps/api/src/lib/import/pdf-text.ts` — `extractPdfText(bytes)` via unpdf + `classifyPdfError` + `PdfExtractError`.
- `apps/api/src/lib/import/pdf-text.test.ts` — extraction + error-classification tests.
- `apps/api/src/lib/import/fixtures/make-sample-pdf.ts` — committed generator that writes the fixture PDFs.
- `apps/api/src/lib/import/fixtures/sample-statement.pdf` — committed fixture (has a text layer).
- `apps/api/src/lib/import/fixtures/sample-empty.pdf` — committed fixture (page, no text → `pdf_no_text`).
- `e2e/tests/import-pdf.spec.ts` — PDF journey (seed a PDF parser via API → upload fixture → detect → review → commit).

**Modify:**
- `apps/api/src/lib/import/types.ts` — add `PdfParserConfig`/`PdfFingerprint`; widen `ParserConfig`/`ParserFingerprint` unions.
- `apps/api/src/lib/import/validate.ts` — split CSV out; add `validatePdfConfig` + `assertSafeRegex` (ReDoS guard); extend `validateFingerprint`.
- `apps/api/src/lib/import/validate.test.ts` — PDF config/fingerprint + ReDoS tests.
- `apps/api/src/lib/import/detect.ts` — add `fingerprintPdf` + `matchPdfParsers`.
- `apps/api/src/lib/import/detect.test.ts` — PDF marker scoring tests.
- `apps/api/src/lib/import/ai.ts` — add `synthesizePdfConfig`/`refinePdfConfig` + `capPdfSample` + PDF prompt.
- `apps/api/src/lib/import/ai.test.ts` — PDF synth tests.
- `apps/api/src/routes/import-parsers.ts` — format-aware synthesize/refine/preview.
- `apps/api/src/routes/import-parsers-ai.test.ts` — PDF route tests.
- `apps/api/src/routes/imports.ts` — `POST /imports/extract`; format-aware `/accounts/:id/imports`.
- `apps/api/src/routes/imports.test.ts` — extract + PDF import tests.
- `apps/api/package.json` — add `unpdf` dependency.
- `apps/web/src/components/import-dialog.tsx` — accept `.pdf`; PDF mapping (regex) sub-form; format-aware calls.

**Unchanged (verified):** `csv.ts`, `amount.ts`, `dates.ts`, `dedup.ts`, staging/commit logic in `imports.ts`, `ImportReview`, the `import_parsers` schema (`sourceFormat` already includes `"pdf"`).

---

## Task 1: PDF config + fingerprint types & validation (with ReDoS guard)

**Files:**
- Modify: `apps/api/src/lib/import/types.ts`
- Modify: `apps/api/src/lib/import/validate.ts`
- Test: `apps/api/src/lib/import/validate.test.ts`

- [ ] **Step 1: Add the PDF types to the unions**

In `apps/api/src/lib/import/types.ts`, append before `export type ParserConfig`:

```typescript
export interface PdfParserConfig {
  version: 1;
  format: "pdf";
  region?: { startAfter?: string; stopAt?: string }; // optional regex anchors bounding the txn section
  transactionLine: string;        // JS regex source; MUST contain named groups (?<date>) and (?<amount>); (?<description>) optional
  date: { format: string };       // tokens reused from Spec 1 parseDate: YYYY YY MMMM MMM MM M DD D
  amount: { decimal: string; thousands: string; sign: "negativeIsDebit" | "positiveIsDebit" };
  multiline?: { continuationAppendsTo: "description" }; // non-matching lines appended to previous row's description
}
```

Change the `ParserConfig` line to:

```typescript
export type ParserConfig = CsvParserConfig | PdfParserConfig;
```

Append after `CsvFingerprint`:

```typescript
export interface PdfFingerprint {
  format: "pdf";
  markers: string[]; // normalized (lowercased, trimmed) stable strings
}
```

Change the `ParserFingerprint` line to:

```typescript
export type ParserFingerprint = CsvFingerprint | PdfFingerprint;
```

- [ ] **Step 2: Write failing validation tests**

Append to `apps/api/src/lib/import/validate.test.ts`:

```typescript
import { validateParserConfig as vpc, validateFingerprint as vfp } from "./validate";

const PDF_OK = {
  version: 1, format: "pdf",
  region: { startAfter: "Transaction Details", stopAt: "Closing Balance" },
  transactionLine: "^(?<date>\\d{2}/\\d{2}/\\d{4})\\s+(?<description>.+?)\\s+(?<amount>-?[\\d,]+\\.\\d{2})$",
  date: { format: "DD/MM/YYYY" },
  amount: { decimal: ".", thousands: ",", sign: "negativeIsDebit" },
  multiline: { continuationAppendsTo: "description" },
};

test("validateParserConfig accepts a well-formed PDF config", () => {
  const cfg = vpc(PDF_OK);
  expect(cfg.format).toBe("pdf");
  if (cfg.format !== "pdf") throw new Error("narrow");
  expect(cfg.transactionLine).toContain("(?<date>");
  expect(cfg.region?.startAfter).toBe("Transaction Details");
  expect(cfg.multiline?.continuationAppendsTo).toBe("description");
});

test("validateParserConfig rejects a PDF config missing the date/amount named groups", () => {
  expect(() => vpc({ ...PDF_OK, transactionLine: "^(.+)$" })).toThrow();
});

test("validateParserConfig rejects a ReDoS-prone transactionLine (nested quantifier)", () => {
  expect(() => vpc({ ...PDF_OK, transactionLine: "(?<date>(a+)+)(?<amount>b)" })).toThrow();
});

test("validateParserConfig rejects an over-long transactionLine", () => {
  expect(() => vpc({ ...PDF_OK, transactionLine: "(?<date>a)(?<amount>b)" + "x".repeat(1001) })).toThrow();
});

test("validateParserConfig rejects an uncompilable transactionLine", () => {
  expect(() => vpc({ ...PDF_OK, transactionLine: "(?<date>(?<amount>" })).toThrow();
});

test("validateFingerprint accepts a PDF fingerprint", () => {
  const fp = vfp({ format: "pdf", markers: ["dbs bank", "statement of account"] });
  expect(fp.format).toBe("pdf");
  if (fp.format !== "pdf") throw new Error("narrow");
  expect(fp.markers).toEqual(["dbs bank", "statement of account"]);
});

test("validateFingerprint rejects a PDF fingerprint with non-string markers", () => {
  expect(() => vfp({ format: "pdf", markers: [1, 2] })).toThrow();
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/api && bun test src/lib/import/validate.test.ts`
Expected: FAIL (PDF branch not implemented; `vpc(PDF_OK)` throws `invalid_config`).

- [ ] **Step 4: Implement the PDF validation**

Rewrite `apps/api/src/lib/import/validate.ts` so the top-level functions branch on `format`. Replace the file's contents with:

```typescript
import type { CsvParserConfig, PdfParserConfig, ParserConfig, ParserFingerprint } from "./types";

function fail(): never { throw new Error("invalid_config"); }
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function str(v: unknown): string { if (typeof v !== "string") fail(); return v; }
function num(v: unknown): number { if (typeof v !== "number") fail(); return v; }

// Treat a synthesized/edited regex as untrusted: cap length, reject the classic
// nested-unbounded-quantifier ReDoS shape (e.g. (a+)+ / (a*)* / (\d+)*), and make
// sure it compiles. Returns the source if safe; throws otherwise.
export function assertSafeRegex(src: string): string {
  if (src.length > 1000) fail();
  if (/\([^()]*[+*][^()]*\)[+*]/.test(src)) fail(); // (..+..)+ , (..*..)* , (\d+)*
  if (/[+*]{2,}/.test(src)) fail();                  // a++ , a** , a*+
  try { new RegExp(src); } catch { fail(); }
  return src;
}

function validateCsvConfig(input: Record<string, unknown>): CsvParserConfig {
  const csv = input.csv;
  if (!isObj(csv)) fail();
  const delimiter = str(csv.delimiter);
  if (delimiter.length !== 1) fail();
  const headerRow = num(csv.headerRow);
  const skipRows = num(csv.skipRows);
  if (headerRow < 0 || skipRows < 0) fail();
  const csvBlock = { delimiter, headerRow, skipRows };

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

function validatePdfConfig(input: Record<string, unknown>): PdfParserConfig {
  const transactionLine = assertSafeRegex(str(input.transactionLine));
  if (!transactionLine.includes("(?<date>") || !transactionLine.includes("(?<amount>")) fail();

  const date = input.date; if (!isObj(date)) fail();
  const amount = input.amount; if (!isObj(amount)) fail();
  if (amount.sign !== "negativeIsDebit" && amount.sign !== "positiveIsDebit") fail();

  const config: PdfParserConfig = {
    version: 1, format: "pdf", transactionLine,
    date: { format: str(date.format) },
    amount: { decimal: str(amount.decimal), thousands: str(amount.thousands), sign: amount.sign },
  };

  if (isObj(input.region)) {
    const region: { startAfter?: string; stopAt?: string } = {};
    if (input.region.startAfter !== undefined) region.startAfter = assertSafeRegex(str(input.region.startAfter));
    if (input.region.stopAt !== undefined) region.stopAt = assertSafeRegex(str(input.region.stopAt));
    config.region = region;
  }
  if (isObj(input.multiline) && input.multiline.continuationAppendsTo === "description") {
    config.multiline = { continuationAppendsTo: "description" };
  }
  return config;
}

export function validateParserConfig(input: unknown): ParserConfig {
  if (!isObj(input)) fail();
  if (input.version !== 1) fail();
  if (input.format === "csv") return validateCsvConfig(input);
  if (input.format === "pdf") return validatePdfConfig(input);
  return fail();
}

export function validateFingerprint(input: unknown): ParserFingerprint {
  if (!isObj(input)) throw new Error("invalid_fingerprint");
  if (input.format === "csv") {
    if (typeof input.delimiter !== "string" || input.delimiter.length !== 1) throw new Error("invalid_fingerprint");
    if (!Array.isArray(input.headerColumns) || input.headerColumns.length > 200) throw new Error("invalid_fingerprint");
    const headerColumns: string[] = [];
    for (const c of input.headerColumns) {
      if (typeof c !== "string") throw new Error("invalid_fingerprint");
      headerColumns.push(c);
    }
    return { format: "csv", delimiter: input.delimiter, headerColumns };
  }
  if (input.format === "pdf") {
    if (!Array.isArray(input.markers) || input.markers.length > 200) throw new Error("invalid_fingerprint");
    const markers: string[] = [];
    for (const m of input.markers) {
      if (typeof m !== "string") throw new Error("invalid_fingerprint");
      markers.push(m);
    }
    return { format: "pdf", markers };
  }
  throw new Error("invalid_fingerprint");
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/api && bun test src/lib/import/validate.test.ts`
Expected: PASS (existing CSV tests + new PDF tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/import/types.ts apps/api/src/lib/import/validate.ts apps/api/src/lib/import/validate.test.ts
git commit -m "feat(import): PDF parser config + fingerprint types and validation with ReDoS guard"
```

---

## Task 2: `runPdfParser` rule engine

**Files:**
- Create: `apps/api/src/lib/import/pdf.ts`
- Test: `apps/api/src/lib/import/pdf.test.ts`

- [ ] **Step 1: Write the failing engine tests**

Create `apps/api/src/lib/import/pdf.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { runPdfParser } from "./pdf";
import type { PdfParserConfig } from "./types";

const CFG: PdfParserConfig = {
  version: 1, format: "pdf",
  region: { startAfter: "Transaction Details", stopAt: "Closing Balance" },
  transactionLine: "^(?<date>\\d{2}/\\d{2}/\\d{4})\\s+(?<description>.+?)\\s+(?<amount>-?[\\d,]+\\.\\d{2})$",
  date: { format: "DD/MM/YYYY" },
  amount: { decimal: ".", thousands: ",", sign: "negativeIsDebit" },
};

const TEXT = [
  "DBS BANK STATEMENT",
  "Account 1234",
  "Transaction Details",
  "02/01/2026 COFFEE BEAN -4.50",
  "03/01/2026 SALARY 2,500.00",
  "Closing Balance 9,999.00",
  "Page 1 of 1",
].join("\n");

test("extracts only rows inside the region and maps date/description/amount", () => {
  const rows = runPdfParser(TEXT, CFG, "USD");
  expect(rows.length).toBe(2);
  expect(rows[0]).toMatchObject({ date: "2026-01-02", amountMinor: -450, description: "COFFEE BEAN" });
  expect(rows[1]).toMatchObject({ date: "2026-01-03", amountMinor: 250000, description: "SALARY" });
  expect(rows[0].raw.line).toBe("02/01/2026 COFFEE BEAN -4.50");
});

test("positiveIsDebit flips the sign", () => {
  const rows = runPdfParser(TEXT, { ...CFG, amount: { ...CFG.amount, sign: "positiveIsDebit" } }, "USD");
  expect(rows[0].amountMinor).toBe(450);   // -4.50 parsed, then negated
  expect(rows[1].amountMinor).toBe(-250000);
});

test("without a region, all matching lines are parsed and non-matching ignored", () => {
  const rows = runPdfParser(TEXT, { ...CFG, region: undefined }, "USD");
  expect(rows.length).toBe(2);
});

test("multiline continuation appends non-matching lines to the previous description", () => {
  const text = [
    "Transaction Details",
    "02/01/2026 COFFEE BEAN -4.50",
    "  ROASTERS PTE LTD",
    "Closing Balance",
  ].join("\n");
  const rows = runPdfParser(text, { ...CFG, multiline: { continuationAppendsTo: "description" } }, "USD");
  expect(rows.length).toBe(1);
  expect(rows[0].description).toBe("COFFEE BEAN ROASTERS PTE LTD");
});

test("a matching line with an unparseable date is flagged as an error row", () => {
  const text = ["Transaction Details", "99/99/2026 BAD -1.00", "Closing Balance"].join("\n");
  const rows = runPdfParser(text, CFG, "USD");
  expect(rows.length).toBe(1);
  expect(rows[0].error).toBe("unparseable_date");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && bun test src/lib/import/pdf.test.ts`
Expected: FAIL ("Cannot find module './pdf'" / `runPdfParser` undefined).

- [ ] **Step 3: Implement the engine**

Create `apps/api/src/lib/import/pdf.ts`:

```typescript
import { parseDate } from "./dates";
import { parseAmountToMinor } from "./amount";
import type { CanonicalRow, PdfParserConfig } from "./types";

// Slice the lines down to the transaction section using the optional regex anchors.
// startAfter: first line matching it is excluded; everything after begins the section.
// stopAt: first line matching it (at or after the start) ends the section (excluded).
function sliceRegion(lines: string[], region?: PdfParserConfig["region"]): string[] {
  if (!region) return lines;
  let start = 0;
  let end = lines.length;
  if (region.startAfter) {
    const re = new RegExp(region.startAfter);
    const i = lines.findIndex((l) => re.test(l));
    if (i >= 0) start = i + 1;
  }
  if (region.stopAt) {
    const re = new RegExp(region.stopAt);
    for (let i = start; i < lines.length; i++) {
      if (re.test(lines[i])) { end = i; break; }
    }
  }
  return lines.slice(start, end);
}

// Run a validated PDF parser config over extracted statement text.
// The config MUST have passed validateParserConfig (regexes are compiled here).
export function runPdfParser(text: string, config: PdfParserConfig, currency: string): CanonicalRow[] {
  const lineRe = new RegExp(config.transactionLine);
  // Trim trailing whitespace per line: PDF extraction often leaves trailing spaces
  // that would break a `$`-anchored regex. Leading whitespace is preserved.
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+$/, ""));
  const region = sliceRegion(lines, config.region);
  const out: CanonicalRow[] = [];

  for (const line of region) {
    const m = lineRe.exec(line);
    if (!m || !m.groups) {
      if (config.multiline?.continuationAppendsTo === "description" && out.length > 0 && line.trim() !== "") {
        const prev = out[out.length - 1];
        prev.description = `${prev.description} ${line.trim()}`.trim();
        prev.raw.line = `${prev.raw.line ?? ""}\n${line}`;
      }
      continue;
    }
    const g = m.groups;
    const raw: Record<string, string> = { line };
    for (const [k, v] of Object.entries(g)) if (typeof v === "string") raw[k] = v;

    const date = parseDate(g.date ?? "", config.date.format);
    let amountMinor = parseAmountToMinor(g.amount ?? "", {
      decimal: config.amount.decimal, thousands: config.amount.thousands, currency,
    });
    if (amountMinor !== null && config.amount.sign === "positiveIsDebit") amountMinor = -amountMinor;

    const row: CanonicalRow = { raw, date, amountMinor, description: (g.description ?? "").trim() };
    if (date === null) row.error = "unparseable_date";
    else if (amountMinor === null) row.error = "unparseable_amount";
    out.push(row);
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && bun test src/lib/import/pdf.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/import/pdf.ts apps/api/src/lib/import/pdf.test.ts
git commit -m "feat(import): deterministic runPdfParser rule engine (region + line regex + multiline)"
```

---

## Task 3: PDF fingerprint + matcher

**Files:**
- Modify: `apps/api/src/lib/import/detect.ts`
- Test: `apps/api/src/lib/import/detect.test.ts`

- [ ] **Step 1: Write failing detect tests**

Append to `apps/api/src/lib/import/detect.test.ts`:

```typescript
import { fingerprintPdf, matchPdfParsers } from "./detect";

const STATEMENT = [
  "DBS Bank Statement of Account",
  "Customer Service 1800 111 1111",
  "Transaction Details",
  "02/01/2026 COFFEE BEAN -4.50",
  "03/01/2026 SALARY 2,500.00",
  "Closing Balance 9,999.00",
].join("\n");

test("fingerprintPdf extracts lowercased non-transaction marker lines", () => {
  const fp = fingerprintPdf(STATEMENT);
  expect(fp.format).toBe("pdf");
  expect(fp.markers).toContain("dbs bank statement of account");
  expect(fp.markers).toContain("transaction details");
  // transaction/amount lines are excluded
  expect(fp.markers.some((m) => m.includes("coffee bean"))).toBe(false);
});

test("matchPdfParsers scores by marker Jaccard and flags confident matches", () => {
  const fp = fingerprintPdf(STATEMENT);
  const saved = [{ id: "p1", name: "DBS", fingerprint: fingerprintPdf(STATEMENT) }];
  const out = matchPdfParsers(fp, saved);
  expect(out[0].parserId).toBe("p1");
  expect(out[0].score).toBe(1);
  expect(out[0].confident).toBe(true);
});

test("matchPdfParsers ignores non-pdf fingerprints", () => {
  const fp = fingerprintPdf(STATEMENT);
  const out = matchPdfParsers(fp, []);
  expect(out.length).toBe(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && bun test src/lib/import/detect.test.ts`
Expected: FAIL (`fingerprintPdf` / `matchPdfParsers` not exported).

- [ ] **Step 3: Implement the PDF detect functions**

Append to `apps/api/src/lib/import/detect.ts` (keep existing CSV exports and the existing private `jaccard`):

```typescript
import type { PdfFingerprint } from "./types";

// Build a marker fingerprint from extracted PDF text: stable header/footer phrases
// (issuer/bank name, section headers) that recur across statements of one format.
// Skip lines that look like transactions (dates/amounts) and out-of-range lengths.
export function fingerprintPdf(text: string): PdfFingerprint {
  const markers: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim().toLowerCase();
    if (l.length < 4 || l.length > 60) continue;
    if (/\d{1,4}[/-]\d{1,2}[/-]\d{1,4}/.test(l)) continue; // dates
    if (/\d[\d,]*\.\d{2}/.test(l)) continue;               // amounts
    if (seen.has(l)) continue;
    seen.add(l);
    markers.push(l);
    if (markers.length >= 12) break;
  }
  return { format: "pdf", markers };
}

export function matchPdfParsers(
  fp: PdfFingerprint,
  parsers: Array<{ id: string; name: string; fingerprint: PdfFingerprint }>,
): ParserCandidate[] {
  return parsers
    .filter((p) => p.fingerprint.format === "pdf")
    .map((p) => {
      const score = jaccard(fp.markers, p.fingerprint.markers);
      return { parserId: p.id, name: p.name, score, confident: score >= 0.6 };
    })
    .sort((a, b) => b.score - a.score);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && bun test src/lib/import/detect.test.ts`
Expected: PASS (existing CSV tests + 3 new PDF tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/import/detect.ts apps/api/src/lib/import/detect.test.ts
git commit -m "feat(import): PDF marker fingerprint + matcher"
```

---

## Task 4: PDF text extraction (`unpdf`) + fixtures

**Files:**
- Modify: `apps/api/package.json`
- Create: `apps/api/src/lib/import/fixtures/make-sample-pdf.ts`
- Create: `apps/api/src/lib/import/fixtures/sample-statement.pdf` (generated)
- Create: `apps/api/src/lib/import/fixtures/sample-empty.pdf` (generated)
- Create: `apps/api/src/lib/import/pdf-text.ts`
- Test: `apps/api/src/lib/import/pdf-text.test.ts`

- [ ] **Step 1: Add the `unpdf` dependency**

Run: `cd apps/api && bun add unpdf`
Expected: `installed unpdf@1.6.x`, `package.json` gains `"unpdf"` under dependencies.

- [ ] **Step 2: Write the fixture generator**

Create `apps/api/src/lib/import/fixtures/make-sample-pdf.ts`:

```typescript
// Generates the committed fixture PDFs used by pdf-text tests and the e2e PDF spec.
// Each statement line is drawn as ONE `(...) Tj` text-show op, so unpdf extracts
// each line back verbatim. Run with: `bun run src/lib/import/fixtures/make-sample-pdf.ts`
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const SAMPLE_STATEMENT_LINES = [
  "DBS Bank Statement of Account",
  "Customer Service 1800 111 1111",
  "Transaction Details",
  "02/01/2026 COFFEE BEAN -4.50",
  "03/01/2026 SALARY 2,500.00",
  "Closing Balance 9,999.00",
  "Page 1 of 1",
];

// Build a minimal single-page PDF whose content stream prints `lines`, one per row.
// Offsets for the xref table are computed from byte positions (content is ASCII).
export function buildStatementPdf(lines: string[]): Uint8Array {
  let content = "BT /F1 12 Tf 72 720 Td 14 TL\n";
  lines.forEach((l, i) => {
    const esc = l.replace(/([\\()])/g, "\\$1");
    content += i === 0 ? `(${esc}) Tj\n` : `T* (${esc}) Tj\n`;
  });
  content += "ET";

  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((off) => { pdf += `${String(off).padStart(10, "0")} 00000 n \n`; });
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

if (import.meta.main) {
  const dir = import.meta.dir;
  writeFileSync(join(dir, "sample-statement.pdf"), buildStatementPdf(SAMPLE_STATEMENT_LINES));
  writeFileSync(join(dir, "sample-empty.pdf"), buildStatementPdf([])); // page, no text ops
  console.log("wrote sample-statement.pdf and sample-empty.pdf");
}
```

- [ ] **Step 3: Generate the committed fixtures**

Run: `cd apps/api && bun run src/lib/import/fixtures/make-sample-pdf.ts`
Expected: `wrote sample-statement.pdf and sample-empty.pdf`; both files exist under `src/lib/import/fixtures/`.

- [ ] **Step 4: Write failing extraction tests**

Create `apps/api/src/lib/import/pdf-text.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractPdfText, classifyPdfError, PdfExtractError } from "./pdf-text";

const fixture = (name: string) => new Uint8Array(readFileSync(join(import.meta.dir, "fixtures", name)));

test("extractPdfText returns the text layer of a text PDF", async () => {
  const text = await extractPdfText(fixture("sample-statement.pdf"));
  expect(text).toContain("DBS Bank Statement of Account");
  expect(text).toContain("Transaction Details");
  expect(text).toContain("COFFEE BEAN");
});

test("extractPdfText throws pdf_no_text for a page with no text layer", async () => {
  await expect(extractPdfText(fixture("sample-empty.pdf"))).rejects.toMatchObject({ code: "pdf_no_text" });
});

test("classifyPdfError maps a PasswordException to pdf_encrypted", () => {
  const err = Object.assign(new Error("No password given"), { name: "PasswordException" });
  expect(classifyPdfError(err)).toBe("pdf_encrypted");
});

test("classifyPdfError returns null for an unrelated error", () => {
  expect(classifyPdfError(new Error("boom"))).toBeNull();
});

test("PdfExtractError carries its code", () => {
  expect(new PdfExtractError("pdf_no_text").code).toBe("pdf_no_text");
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `cd apps/api && bun test src/lib/import/pdf-text.test.ts`
Expected: FAIL ("Cannot find module './pdf-text'").

- [ ] **Step 6: Implement the extractor**

Create `apps/api/src/lib/import/pdf-text.ts`:

```typescript
import { extractText } from "unpdf";

export type PdfErrorCode = "pdf_encrypted" | "pdf_no_text";

export class PdfExtractError extends Error {
  constructor(public code: PdfErrorCode) { super(code); this.name = "PdfExtractError"; }
}

// Map an unpdf/pdf.js error to a known code, or null if it's not one we handle.
export function classifyPdfError(err: unknown): PdfErrorCode | null {
  const name = err instanceof Error ? err.name : "";
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (name === "PasswordException" || msg.includes("password") || msg.includes("encrypt")) return "pdf_encrypted";
  return null;
}

// Extract the concatenated text layer from PDF bytes. Pages are joined with "\n".
// Throws PdfExtractError("pdf_encrypted") for password-protected PDFs and
// PdfExtractError("pdf_no_text") for scanned/image PDFs with no extractable text.
export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  let pages: string[];
  try {
    const res = await extractText(bytes, { mergePages: false });
    pages = Array.isArray(res.text) ? res.text : [res.text];
  } catch (err) {
    const code = classifyPdfError(err);
    if (code) throw new PdfExtractError(code);
    throw err;
  }
  const text = pages.join("\n").replace(/ /g, "").replace(/[ \t]+\n/g, "\n").trim();
  if (text.length === 0) throw new PdfExtractError("pdf_no_text");
  return text;
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd apps/api && bun test src/lib/import/pdf-text.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 8: Commit**

```bash
git add apps/api/package.json apps/api/bun.lock apps/api/src/lib/import/fixtures apps/api/src/lib/import/pdf-text.ts apps/api/src/lib/import/pdf-text.test.ts
git commit -m "feat(import): PDF text extraction via unpdf + committed fixtures"
```

(If the lockfile is named `bun.lockb`, add that instead; `git status` will show which.)

---

## Task 5: AI synthesize/refine for PDF

**Files:**
- Modify: `apps/api/src/lib/import/ai.ts`
- Test: `apps/api/src/lib/import/ai.test.ts`

- [ ] **Step 1: Write failing AI tests**

Append to `apps/api/src/lib/import/ai.test.ts`:

```typescript
import { synthesizePdfConfig, refinePdfConfig, capPdfSample } from "./ai";

const goodPdf = {
  version: 1, format: "pdf",
  region: { startAfter: "Transaction Details", stopAt: "Closing Balance" },
  transactionLine: "^(?<date>\\d{2}/\\d{2}/\\d{4})\\s+(?<description>.+?)\\s+(?<amount>-?[\\d,]+\\.\\d{2})$",
  date: { format: "DD/MM/YYYY" },
  amount: { decimal: ".", thousands: ",", sign: "negativeIsDebit" },
};

test("synthesizePdfConfig returns a validated pdf config from the model's JSON", async () => {
  const chat = async () => goodPdf;
  const out = await synthesizePdfConfig("Transaction Details\n02/01/2026 X -1.00\nClosing Balance", cfg, chat);
  expect(out.format).toBe("pdf");
  expect(out.transactionLine).toContain("(?<amount>");
});

test("synthesizePdfConfig rejects a model that returns a CSV config", async () => {
  const chat = async () => goodConfig; // CSV shape from the existing tests above
  await expect(synthesizePdfConfig("x", cfg, chat)).rejects.toThrow(AiError);
});

test("refinePdfConfig returns a new validated pdf config", async () => {
  const chat = async () => goodPdf;
  const out = await refinePdfConfig("sample", goodPdf, "fix dates", [], cfg, chat);
  expect(out.format).toBe("pdf");
});

test("capPdfSample caps to ~8KB on a line boundary", () => {
  const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
  const out = capPdfSample(big);
  expect(out.length).toBeLessThanOrEqual(8000);
  expect(out.endsWith("\n")).toBe(false); // trimmed to last full line
});
```

Note: `cfg`, `goodConfig`, and `AiError` are already defined/imported at the top of this test file by the existing CSV tests.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && bun test src/lib/import/ai.test.ts`
Expected: FAIL (`synthesizePdfConfig` / `refinePdfConfig` / `capPdfSample` not exported).

- [ ] **Step 3: Implement the PDF AI functions**

In `apps/api/src/lib/import/ai.ts`:

Change the import on line 2 to include the PDF type:

```typescript
import type { CsvParserConfig, PdfParserConfig } from "./types";
```

Append at the end of the file:

```typescript
const PDF_CONFIG_SHAPE = `{
  "version": 1, "format": "pdf",
  "region": { "startAfter": "<regex of a header line just ABOVE the transactions, or omit region>", "stopAt": "<regex of a line just AFTER the last transaction, or omit>" },
  "transactionLine": "<a single-line JS regex with named groups (?<date>...), (?<description>...), (?<amount>...) matching ONE transaction row>",
  "date": { "format": "<tokens: YYYY YY MM M MMM DD D>" },
  "amount": { "decimal": ".", "thousands": ",", "sign": "negativeIsDebit|positiveIsDebit" },
  "multiline": { "continuationAppendsTo": "description" }
}`;

const PDF_SYSTEM = `You convert sample text extracted from a bank or credit-card PDF statement into a deterministic parser config.
Reply with ONLY a JSON object of exactly this shape (no prose):
${PDF_CONFIG_SHAPE}
Rules: "transactionLine" must be a single-line JS regex containing named groups (?<date>) and (?<amount>) (and (?<description>) when a description exists); it must match exactly one transaction row from the sample. Infer "date.format" from the date values using only the listed tokens. Choose "region.startAfter"/"region.stopAt" from visible section headers/footers that bound the transaction list, or omit "region" entirely if it is not needed. Pick "sign" so money leaving the account is negative. Keep the regex simple: NEVER use nested quantifiers like (a+)+ or (\\d+)*.`;

// Cap extracted statement text to ~8 KB on a line boundary before sending to the model.
export function capPdfSample(text: string): string {
  if (text.length <= 8000) return text;
  const cut = text.slice(0, 8000);
  const lastNl = cut.lastIndexOf("\n");
  return (lastNl > 0 ? cut.slice(0, lastNl) : cut).replace(/\s+$/, "");
}

function asPdfConfig(raw: unknown): PdfParserConfig {
  const cfg = validateParserConfig(raw);
  if (cfg.format !== "pdf") throw new AiError("ai_invalid_output", "expected a pdf config");
  return cfg;
}

export async function synthesizePdfConfig(
  sample: string, cfg: AiConfig, chat: Chat = defaultChat,
): Promise<PdfParserConfig> {
  const raw = await chat(cfg, PDF_SYSTEM, `Sample statement text:\n${sample}`);
  try {
    return asPdfConfig(raw);
  } catch (e) {
    if (e instanceof AiError) throw e;
    throw new AiError("ai_invalid_output", "config failed validation");
  }
}

export async function refinePdfConfig(
  sample: string,
  current: PdfParserConfig,
  instruction: string,
  errors: Array<{ raw: Record<string, string>; reason: string }>,
  cfg: AiConfig,
  chat: Chat = defaultChat,
): Promise<PdfParserConfig> {
  const user = [
    `Sample statement text:\n${sample}`,
    `Current config:\n${JSON.stringify(current)}`,
    errors.length ? `Lines that failed to parse:\n${JSON.stringify(errors.slice(0, 10))}` : "",
    `Fix request: ${instruction || "Correct the lines that failed to parse."}`,
  ].filter(Boolean).join("\n\n");
  const raw = await chat(cfg, PDF_SYSTEM, user);
  try {
    return asPdfConfig(raw);
  } catch (e) {
    if (e instanceof AiError) throw e;
    throw new AiError("ai_invalid_output", "config failed validation");
  }
}
```

This reuses the existing `validateParserConfig` import at the top of `ai.ts` (line 1). The `Chat` type and `defaultChat` are already defined in the file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && bun test src/lib/import/ai.test.ts`
Expected: PASS (existing CSV tests + 4 new PDF tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/import/ai.ts apps/api/src/lib/import/ai.test.ts
git commit -m "feat(import): AI synthesize/refine for PDF parser configs"
```

---

## Task 6: Format-aware synthesize / refine / preview routes

**Files:**
- Modify: `apps/api/src/routes/import-parsers.ts`
- Test: `apps/api/src/routes/import-parsers-ai.test.ts`

- [ ] **Step 1: Write failing route tests**

Append to `apps/api/src/routes/import-parsers-ai.test.ts`:

```typescript
const PDF_CONFIG = {
  version: 1, format: "pdf",
  region: { startAfter: "Transaction Details", stopAt: "Closing Balance" },
  transactionLine: "^(?<date>\\d{2}/\\d{2}/\\d{4})\\s+(?<description>.+?)\\s+(?<amount>-?[\\d,]+\\.\\d{2})$",
  date: { format: "DD/MM/YYYY" },
  amount: { decimal: ".", thousands: ",", sign: "negativeIsDebit" },
};
const PDF_TEXT = "Transaction Details\n02/01/2026 COFFEE -4.50\nClosing Balance 9.00";

test("synthesize with format:pdf returns a validated pdf config", async () => {
  const { cookie } = await initAndLogin({ app });
  const mock = startMockAi(PDF_CONFIG);
  try {
    await enableAi(cookie, mock.baseUrl);
    const res = await app.handle(new Request("http://localhost/import-parsers/synthesize", {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ content: PDF_TEXT, format: "pdf" }),
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).config.format).toBe("pdf");
  } finally { mock.stop(); }
});

test("refine with format:pdf returns a validated pdf config", async () => {
  const { cookie } = await initAndLogin({ app });
  const mock = startMockAi(PDF_CONFIG);
  try {
    await enableAi(cookie, mock.baseUrl);
    const res = await app.handle(new Request("http://localhost/import-parsers/refine", {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ content: PDF_TEXT, config: PDF_CONFIG, format: "pdf", instruction: "x", errors: [] }),
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).config.format).toBe("pdf");
  } finally { mock.stop(); }
});

test("preview parses PDF text with a pdf config", async () => {
  const { cookie } = await initAndLogin({ app });
  const res = await app.handle(new Request("http://localhost/import-parsers/preview", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ content: PDF_TEXT, config: PDF_CONFIG, currency: "USD" }),
  }));
  expect(res.status).toBe(200);
  const out = await res.json();
  expect(out.total).toBe(1);
  expect(out.rows[0]).toMatchObject({ date: "2026-01-02", amountMinor: -450, description: "COFFEE" });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && bun test src/routes/import-parsers-ai.test.ts`
Expected: FAIL — synthesize ignores `format` (calls CSV path → invalid output 422) and preview calls `parseCsv` on PDF config.

- [ ] **Step 3: Implement format routing**

In `apps/api/src/routes/import-parsers.ts`:

Update the imports on lines 9–11 to:

```typescript
import { synthesizeCsvConfig, refineCsvConfig, synthesizePdfConfig, refinePdfConfig, capSample, capPdfSample, AiError, type AiConfig } from "../lib/import/ai";
import { parseCsv } from "../lib/import/csv";
import { runPdfParser } from "../lib/import/pdf";
import type { CsvParserConfig, ParserConfig } from "../lib/import/types";
```

Replace the `/import-parsers/synthesize` handler body + schema (lines 89–102) with:

```typescript
  .post(
    "/import-parsers/synthesize",
    async ({ body, set }: any) => {
      const cfg = await loadAiConfig();
      if (!cfg) { set.status = 422; return { error: "ai_not_configured" }; }
      try {
        const config = body.format === "pdf"
          ? await synthesizePdfConfig(capPdfSample(body.content), cfg)
          : await synthesizeCsvConfig(capSample(body.content), cfg);
        return { config };
      } catch (e) {
        return aiErrorResponse(e, set);
      }
    },
    { body: t.Object({
      content: t.String({ maxLength: 200_000 }),
      format: t.Optional(t.Union([t.Literal("csv"), t.Literal("pdf")])),
    }) },
  )
```

Replace the `/import-parsers/refine` handler body + schema (lines 103–125) with:

```typescript
  .post(
    "/import-parsers/refine",
    async ({ body, set }: any) => {
      const cfg = await loadAiConfig();
      if (!cfg) { set.status = 422; return { error: "ai_not_configured" }; }
      try {
        const config = body.format === "pdf"
          ? await refinePdfConfig(capPdfSample(body.content), body.config, body.instruction ?? "", body.errors ?? [], cfg)
          : await refineCsvConfig(capSample(body.content), body.config, body.instruction ?? "", body.errors ?? [], cfg);
        return { config };
      } catch (e) {
        return aiErrorResponse(e, set);
      }
    },
    {
      body: t.Object({
        content: t.String({ maxLength: 200_000 }),
        config: t.Unknown(),
        format: t.Optional(t.Union([t.Literal("csv"), t.Literal("pdf")])),
        instruction: t.Optional(t.String({ maxLength: 500 })),
        errors: t.Optional(t.Array(t.Object({ raw: t.Record(t.String(), t.String()), reason: t.String() }), { maxItems: 50 })),
      }),
    },
  )
```

Replace the `/import-parsers/preview` handler (lines 126–144) with a format-aware version:

```typescript
  .post(
    "/import-parsers/preview",
    async ({ body, set }: any) => {
      let config: ParserConfig;
      try { config = validateParserConfig(body.config); }
      catch { set.status = 422; return { error: "invalid_config" }; }
      const currency = (body.currency ?? "USD").toUpperCase();
      const all = config.format === "pdf"
        ? runPdfParser(body.content, config, currency)
        : parseCsv(body.content, config, currency);
      const bad = all.filter((r) => r.error || r.date === null || r.amountMinor === null);
      return {
        rows: all.slice(0, 5).map((r) => ({
          date: r.date, amountMinor: r.amountMinor, description: r.description, error: r.error ?? null,
        })),
        total: all.length,
        errorCount: bad.length,
        errors: bad.slice(0, 10).map((r) => ({ raw: r.raw, reason: r.error ?? "unparseable" })),
      };
    },
    { body: t.Object({ content: t.String({ maxLength: 200_000 }), config: t.Unknown(), currency: t.Optional(t.String()) }) },
  );
```

Note: the old `import type { CsvParserConfig }` is now widened to `ParserConfig` (used by preview). `CsvParserConfig` is no longer referenced in this file — remove it from the import if the build flags it as unused, leaving `import type { ParserConfig } from "../lib/import/types";`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && bun test src/routes/import-parsers-ai.test.ts`
Expected: PASS (existing CSV tests + 3 new PDF tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/import-parsers.ts apps/api/src/routes/import-parsers-ai.test.ts
git commit -m "feat(import): format-aware synthesize/refine/preview routes"
```

---

## Task 7: `/imports/extract` endpoint + format-aware import

**Files:**
- Modify: `apps/api/src/routes/imports.ts`
- Test: `apps/api/src/routes/imports.test.ts`

- [ ] **Step 1: Write failing route tests**

Append to `apps/api/src/routes/imports.test.ts`. First inspect the top of the existing file for its helpers (it uses `makeApp`, `initAndLogin`, and creates an account). Mirror that setup. Add:

```typescript
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PDF_PARSER = {
  version: 1, format: "pdf",
  region: { startAfter: "Transaction Details", stopAt: "Closing Balance" },
  transactionLine: "^(?<date>\\d{2}/\\d{2}/\\d{4})\\s+(?<description>.+?)\\s+(?<amount>-?[\\d,]+\\.\\d{2})$",
  date: { format: "DD/MM/YYYY" },
  amount: { decimal: ".", thousands: ",", sign: "negativeIsDebit" },
};
const PDF_FP = { format: "pdf", markers: ["dbs bank statement of account", "transaction details"] };
const samplePdfB64 = () =>
  readFileSync(join(import.meta.dir, "../lib/import/fixtures/sample-statement.pdf")).toString("base64");

test("POST /imports/extract returns text + fingerprint + candidates for a PDF", async () => {
  const { cookie } = await initAndLogin({ app });
  const res = await app.handle(new Request("http://localhost/imports/extract", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ filename: "stmt.pdf", file: samplePdfB64() }),
  }));
  expect(res.status).toBe(200);
  const out = await res.json();
  expect(out.text).toContain("COFFEE BEAN");
  expect(out.fingerprint.format).toBe("pdf");
  expect(Array.isArray(out.candidates)).toBe(true);
});

test("POST /imports/extract returns 422 pdf_no_text for an empty PDF", async () => {
  const { cookie } = await initAndLogin({ app });
  const emptyB64 = readFileSync(join(import.meta.dir, "../lib/import/fixtures/sample-empty.pdf")).toString("base64");
  const res = await app.handle(new Request("http://localhost/imports/extract", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ filename: "x.pdf", file: emptyB64 }),
  }));
  expect(res.status).toBe(422);
  expect((await res.json()).error).toBe("pdf_no_text");
});

test("POST /accounts/:id/imports stages rows from extracted PDF text via a pdf parser", async () => {
  const { cookie, accountId } = await seedAccountAndPdfParser();
  const text = await extractTextViaApi(cookie); // see helper below
  const res = await app.handle(new Request(`http://localhost/accounts/${accountId}/imports`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ filename: "stmt.pdf", content: text, parserId: "pdfp" }),
  }));
  expect(res.status).toBe(200);
  const out = await res.json();
  expect(out.rowCountNew).toBe(2);
});
```

Add these two helpers near the top of the test file (adapt account creation to match the existing file's pattern — it already creates accounts for the CSV tests; reuse that exact code):

```typescript
async function extractTextViaApi(cookie: string): Promise<string> {
  const res = await app.handle(new Request("http://localhost/imports/extract", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ filename: "stmt.pdf", file: samplePdfB64() }),
  }));
  return (await res.json()).text;
}

async function seedAccountAndPdfParser(): Promise<{ cookie: string; accountId: string }> {
  const { cookie } = await initAndLogin({ app });
  // Create an account the same way the existing CSV tests in this file do:
  const accRes = await app.handle(new Request("http://localhost/accounts", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Checking", type: "asset", subtype: "cash", currency: "USD" }),
  }));
  const accountId = (await accRes.json()).id;
  await app.handle(new Request("http://localhost/import-parsers", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ id: "pdfp", name: "DBS PDF", sourceFormat: "pdf", config: PDF_PARSER, fingerprint: PDF_FP, origin: "ai" }),
  }));
  return { cookie, accountId };
}
```

Note: match the account-create payload to whatever the existing tests in `imports.test.ts` use (field names/types). If the existing tests use a helper, call it instead.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && bun test src/routes/imports.test.ts`
Expected: FAIL — `/imports/extract` returns 404 (route missing); PDF import stages 0 new rows (still using `parseCsv`).

- [ ] **Step 3: Implement the extract endpoint + import branch**

In `apps/api/src/routes/imports.ts`:

Add imports near the top (after the existing import block, lines 9–14):

```typescript
import { fingerprintPdf, matchParsers, matchPdfParsers } from "../lib/import/detect";
import { extractPdfText, PdfExtractError } from "../lib/import/pdf-text";
import { runPdfParser } from "../lib/import/pdf";
import type { ParserConfig } from "../lib/import/types";
```

Then remove the now-duplicated `matchParsers` from the existing line-10 import (line 10 becomes `import { fingerprintCsv } from "../lib/import/detect";` since `matchParsers` is imported in the new block — or keep them together; just avoid importing `matchParsers` twice).

Add the new endpoint immediately after the `/imports/detect` route (after line 38), before `/accounts/:id/imports`:

```typescript
  // ---- extract: PDF bytes -> text + fingerprint + ranked saved PDF parsers ----
  .post(
    "/imports/extract",
    async ({ body, set }: any) => {
      let text: string;
      try {
        text = await extractPdfText(new Uint8Array(Buffer.from(body.file, "base64")));
      } catch (e) {
        if (e instanceof PdfExtractError) { set.status = 422; return { error: e.code }; }
        throw e;
      }
      const fp = fingerprintPdf(text);
      const parsers = await db.select().from(importParsers).where(eq(importParsers.sourceFormat, "pdf"));
      const valid: { id: string; name: string; fingerprint: ReturnType<typeof validateFingerprint> }[] = [];
      for (const p of parsers) {
        try {
          valid.push({ id: p.id, name: p.name, fingerprint: validateFingerprint(JSON.parse(p.fingerprint)) });
        } catch {
          // skip parsers whose stored fingerprint is malformed rather than crash extract
        }
      }
      const pdfValid = valid.filter((v): v is typeof v & { fingerprint: { format: "pdf"; markers: string[] } } =>
        v.fingerprint.format === "pdf");
      const candidates = matchPdfParsers(fp, pdfValid);
      return { text, fingerprint: fp, candidates };
    },
    { body: t.Object({ filename: t.String(), file: t.String({ maxLength: 20_000_000 }) }) },
  )
```

In the `/accounts/:id/imports` handler, replace the parse line (currently line 49 `const canonical = parseCsv(body.content, config, account.currency);`) with a format branch. Change the `config` declaration + parse to:

```typescript
      const config: ParserConfig = validateParserConfig(JSON.parse(parser.config));
      const canonical = config.format === "pdf"
        ? runPdfParser(body.content, config, account.currency)
        : parseCsv(body.content, config, account.currency);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && bun test src/routes/imports.test.ts`
Expected: PASS (existing CSV tests + 3 new PDF tests).

- [ ] **Step 5: Run the full API test suite**

Run: `cd apps/api && bun test`
Expected: PASS (all import + route suites green).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/imports.ts apps/api/src/routes/imports.test.ts
git commit -m "feat(import): /imports/extract endpoint + format-aware staging"
```

---

## Task 8: Client dialog — PDF support

**Files:**
- Modify: `apps/web/src/components/import-dialog.tsx`

The dialog gains a `format` state. CSV behaves exactly as today. For PDF: the dropzone accepts `.pdf`; on drop the client base64-encodes the bytes, calls `/imports/extract`, stores the returned text as `content` and the returned `fingerprint`, and shows a regex-based mapping sub-form instead of column pickers. Synthesize/refine pass `format: "pdf"`; save uses `sourceFormat: "pdf"` and the extracted fingerprint.

- [ ] **Step 1: Replace the dialog file**

Overwrite `apps/web/src/components/import-dialog.tsx` with:

```tsx
import { useState, useEffect, useRef } from "react";
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
import type { CsvParserConfig, PdfParserConfig } from "../../../api/src/lib/import/types";

type Candidate = { parserId: string; name: string; score: number; confident: boolean };
type Detect = { fingerprint: unknown; candidates: Candidate[] };
type Format = "csv" | "pdf";

const NEW_PARSER = "__new__";

type PreviewRow = { date: string | null; amountMinor: number | null; description: string };
type PreviewError = { raw: Record<string, string>; reason: string };
type Preview = { rows: PreviewRow[]; total: number; errorCount: number; errors: PreviewError[] };

function arrayBufferToBase64(buf: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function ImportDialog({ accountId, accountCurrency }: { accountId: string; accountCurrency: string }) {
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<Format>("csv");
  const [filename, setFilename] = useState("");
  const [content, setContent] = useState("");          // CSV text, or PDF-extracted text
  const [pdfFingerprint, setPdfFingerprint] = useState<unknown>(null);
  const [detect, setDetect] = useState<Detect | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [parserId, setParserId] = useState<string>("");
  const [batchId, setBatchId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fileError, setFileError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // CSV new-parser column mapping fields
  const [name, setName] = useState("");
  const [dateCol, setDateCol] = useState("");
  const [dateFmt, setDateFmt] = useState("YYYY-MM-DD");
  const [descCol, setDescCol] = useState("");
  const [amountCol, setAmountCol] = useState("");
  const [sign, setSign] = useState<"negativeIsDebit" | "positiveIsDebit">("negativeIsDebit");

  // PDF new-parser regex mapping fields
  const [txnLine, setTxnLine] = useState("");
  const [startAfter, setStartAfter] = useState("");
  const [stopAt, setStopAt] = useState("");
  const [multiline, setMultiline] = useState(false);

  // AI state
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMsg, setAiMsg] = useState("");
  const [refineText, setRefineText] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);

  useEffect(() => {
    api.settings.get().then(({ data }) => {
      if (data && "aiBaseUrl" in data) setAiEnabled(!!data.aiBaseUrl && !!data.aiModel);
    }).catch(() => {});
  }, []);

  function reset() {
    setFormat("csv"); setFilename(""); setContent(""); setPdfFingerprint(null); setDetect(null);
    setHeaders([]); setParserId(""); setBatchId(null); setFileError("");
    setName(""); setDateCol(""); setDescCol(""); setAmountCol("");
    setDateFmt("YYYY-MM-DD"); setSign("negativeIsDebit");
    setTxnLine(""); setStartAfter(""); setStopAt(""); setMultiline(false);
    setAiBusy(false); setAiMsg(""); setRefineText(""); setPreview(null);
  }

  async function handleFile(file: File) {
    setFileError("");
    const isPdf = file.name.toLowerCase().endsWith(".pdf") || file.type === "application/pdf";
    if (isPdf) {
      setFormat("pdf");
      setFilename(file.name);
      const b64 = arrayBufferToBase64(await file.arrayBuffer());
      const { data, error } = await api.imports.extract.post({ filename: file.name, file: b64 });
      if (error || !data || !("text" in data)) {
        const code = (error && typeof error === "object" && "value" in error
          ? (error.value as { error?: string }).error : undefined);
        setFileError(
          code === "pdf_encrypted" ? "Remove the password and re-upload."
          : code === "pdf_no_text" ? "This looks like a scanned PDF — OCR isn't supported yet."
          : "Couldn't read this PDF.",
        );
        return;
      }
      setContent(data.text);
      setPdfFingerprint(data.fingerprint);
      setDetect({ fingerprint: data.fingerprint, candidates: data.candidates });
      const top = data.candidates.find((c) => c.confident) ?? data.candidates[0];
      setParserId(top ? top.parserId : NEW_PARSER);
      return;
    }
    setFormat("csv");
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

  function buildCsvConfig(): CsvParserConfig {
    return {
      version: 1, format: "csv",
      csv: { delimiter: ",", headerRow: 0, skipRows: 0 },
      fields: {
        date: { column: dateCol, format: dateFmt },
        description: { column: descCol },
        amount: { mode: "single", column: amountCol, decimal: ".", thousands: ",", sign },
      },
      rowFilter: { dropIfBlank: ["date", "amount"] },
    };
  }

  function buildPdfConfig(): PdfParserConfig {
    const cfg: PdfParserConfig = {
      version: 1, format: "pdf",
      transactionLine: txnLine,
      date: { format: dateFmt },
      amount: { decimal: ".", thousands: ",", sign },
    };
    if (startAfter || stopAt) cfg.region = { ...(startAfter ? { startAfter } : {}), ...(stopAt ? { stopAt } : {}) };
    if (multiline) cfg.multiline = { continuationAppendsTo: "description" };
    return cfg;
  }

  function buildConfig(): CsvParserConfig | PdfParserConfig {
    return format === "pdf" ? buildPdfConfig() : buildCsvConfig();
  }

  function applyConfig(cfg: CsvParserConfig | PdfParserConfig) {
    if (cfg.format === "pdf") {
      setTxnLine(cfg.transactionLine);
      setDateFmt(cfg.date.format);
      setSign(cfg.amount.sign);
      setStartAfter(cfg.region?.startAfter ?? "");
      setStopAt(cfg.region?.stopAt ?? "");
      setMultiline(cfg.multiline?.continuationAppendsTo === "description");
      return;
    }
    setDateCol(cfg.fields.date.column);
    setDateFmt(cfg.fields.date.format);
    setDescCol(cfg.fields.description.column);
    if (cfg.fields.amount.mode === "single") {
      setAmountCol(cfg.fields.amount.column);
      setSign(cfg.fields.amount.sign === "positiveIsDebit" ? "positiveIsDebit" : "negativeIsDebit");
    }
  }

  // Live preview — debounced whenever mapping changes
  useEffect(() => {
    const needsMapping = parserId === NEW_PARSER;
    const csvReady = format === "csv" && dateCol && descCol && amountCol;
    const pdfReady = format === "pdf" && txnLine;
    if (!content || !needsMapping || (!csvReady && !pdfReady)) {
      setPreview(null);
      return;
    }
    const cfg = buildConfig();
    const t = setTimeout(() => {
      void (async () => {
        const { data } = await api["import-parsers"].preview.post({ content, config: cfg, currency: accountCurrency });
        if (data && "rows" in data && data.rows !== undefined) {
          setPreview({ rows: data.rows, total: data.total, errorCount: data.errorCount, errors: data.errors ?? [] });
        }
      })();
    }, 400);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, parserId, format, dateCol, dateFmt, descCol, amountCol, sign, txnLine, startAfter, stopAt, multiline, accountCurrency]);

  async function runRefine(instruction: string) {
    setAiBusy(true);
    try {
      const { data, error } = await api["import-parsers"].refine.post({
        content, config: buildConfig(), format, instruction, errors: preview?.errors ?? [],
      });
      if (error || !data || !("config" in data)) { setAiMsg("Refine failed"); return; }
      applyConfig(data.config);
      setRefineText("");
      setAiMsg("");
    } finally {
      setAiBusy(false);
    }
  }

  async function generate() {
    setAiBusy(true);
    try {
      const { data, error } = await api["import-parsers"].synthesize.post({ content, format });
      if (error || !data || !("config" in data)) { setAiMsg("AI couldn't generate — map manually"); return; }
      applyConfig(data.config);
      setAiMsg("");
    } finally {
      setAiBusy(false);
    }
  }

  async function run() {
    setBusy(true);
    try {
      let useParserId = parserId;
      if (parserId === NEW_PARSER) {
        const fingerprint = format === "pdf"
          ? (pdfFingerprint ?? { format: "pdf", markers: [] })
          : { format: "csv", delimiter: ",", headerColumns: [...headers].map((h) => h.toLowerCase()).sort() };
        const { data, error } = await api["import-parsers"].post({
          name: name || filename, sourceFormat: format, config: buildConfig(), fingerprint, origin: "manual",
        });
        if (error || !data || !("id" in data)) throw new Error(String(error ?? "parser create failed"));
        useParserId = data.id;
      }
      const { data, error } = await api.accounts({ id: accountId }).imports.post({ filename, content, parserId: useParserId });
      if (error || !data || !("id" in data) || !data.id) throw new Error(String(error ?? "import failed"));
      setBatchId(data.id);
    } finally {
      setBusy(false);
    }
  }

  const needsMapping = parserId === NEW_PARSER;
  const mappingReady = format === "pdf" ? !!txnLine : !!(dateCol && descCol && amountCol);
  const canRun = content !== "" && (!needsMapping || mappingReady);

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger render={<Button variant="outline" />}>Import statement</DialogTrigger>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader><DialogTitle>Import statement (CSV or PDF)</DialogTitle></DialogHeader>

        {batchId ? (
          <ImportReview batchId={batchId} accountCurrency={accountCurrency} onDone={() => { setOpen(false); reset(); }} />
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Statement file</Label>
              <div
                data-testid="import-dropzone"
                onDragOver={(e) => { e.preventDefault(); }}
                onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) void handleFile(f); }}
                onClick={() => fileInputRef.current?.click()}
                className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-input py-8 text-center text-sm text-muted-foreground hover:border-ring"
              >
                <span className="text-base">&#8593; Drop your statement here</span>
                <span>or click to browse (.csv, .pdf){filename ? ` — ${filename}` : ""}</span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,text/csv,.pdf,application/pdf"
                  className="hidden"
                  data-testid="import-file"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); }}
                />
              </div>
              {fileError && <p className="text-sm text-destructive" data-testid="import-file-error">{fileError}</p>}
            </div>

            {content && (
              <div className="space-y-2">
                <Label>Parser</Label>
                <Select value={parserId} onValueChange={(v: string | null) => v && setParserId(v)}>
                  <SelectTrigger data-testid="import-parser">
                    <SelectValue>
                      {(v: unknown) => {
                        const val = typeof v === "string" ? v : "";
                        if (!val) return "Choose a parser";
                        if (val === NEW_PARSER) return "Create a new parser…";
                        const c = detect?.candidates.find((x) => x.parserId === val);
                        return c
                          ? `${c.name}${c.confident ? " (match)" : ` (${Math.round(c.score * 100)}%)`}`
                          : "Choose a parser";
                      }}
                    </SelectValue>
                  </SelectTrigger>
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
              <div className="space-y-4">
                {aiEnabled && (
                  <div className="space-y-1">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!content || aiBusy}
                      data-testid="ai-generate"
                      onClick={() => void generate()}
                    >
                      {aiBusy ? "Generating…" : "✨ Generate with AI"}
                    </Button>
                    {aiMsg && <p className="text-sm text-muted-foreground">{aiMsg}</p>}
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2 space-y-1">
                    <Label>Parser name</Label>
                    <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={filename} data-testid="parser-name" />
                  </div>

                  {format === "pdf" ? (
                    <>
                      <div className="col-span-2 space-y-1">
                        <Label>Transaction line regex</Label>
                        <Input value={txnLine} onChange={(e) => setTxnLine(e.target.value)}
                          placeholder="^(?<date>\\d{2}/\\d{2}/\\d{4})\\s+(?<description>.+?)\\s+(?<amount>-?[\\d,]+\\.\\d{2})$"
                          data-testid="map-txnline" />
                      </div>
                      <div className="space-y-1">
                        <Label>Date format</Label>
                        <Input value={dateFmt} onChange={(e) => setDateFmt(e.target.value)} data-testid="map-dateformat" />
                      </div>
                      <SignSelect sign={sign} setSign={setSign} />
                      <div className="space-y-1">
                        <Label>Region start (regex, optional)</Label>
                        <Input value={startAfter} onChange={(e) => setStartAfter(e.target.value)} data-testid="map-startafter" />
                      </div>
                      <div className="space-y-1">
                        <Label>Region stop (regex, optional)</Label>
                        <Input value={stopAt} onChange={(e) => setStopAt(e.target.value)} data-testid="map-stopat" />
                      </div>
                      <label className="col-span-2 flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={multiline} onChange={(e) => setMultiline(e.target.checked)} data-testid="map-multiline" />
                        Append non-matching lines to the previous description
                      </label>
                    </>
                  ) : (
                    <>
                      <ColumnPick label="Date column" value={dateCol} set={setDateCol} headers={headers} testId="map-date" />
                      <div className="space-y-1">
                        <Label>Date format</Label>
                        <Input value={dateFmt} onChange={(e) => setDateFmt(e.target.value)} data-testid="map-dateformat" />
                      </div>
                      <ColumnPick label="Description column" value={descCol} set={setDescCol} headers={headers} testId="map-desc" />
                      <ColumnPick label="Amount column" value={amountCol} set={setAmountCol} headers={headers} testId="map-amount" />
                      <SignSelect sign={sign} setSign={setSign} />
                    </>
                  )}
                </div>

                {preview && (
                  <div className="space-y-1 rounded-md border p-2 text-sm">
                    <div className="flex justify-between text-muted-foreground">
                      <span>Preview</span>
                      <span>{preview.total - preview.errorCount} ok &middot; {preview.errorCount} errors</span>
                    </div>
                    {preview.rows.map((r, i) => (
                      <div key={i} className="flex justify-between tabular-nums">
                        <span>{r.date ?? "—"}</span>
                        <span className="flex-1 truncate px-2">{r.description}</span>
                        <span>{r.amountMinor === null ? "—" : (r.amountMinor / 100).toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                )}

                {aiEnabled && (
                  <div className="flex items-center gap-2">
                    <Input
                      value={refineText}
                      onChange={(e) => setRefineText(e.target.value)}
                      placeholder="Tell the AI what's off…"
                      data-testid="ai-refine-input"
                    />
                    <Button type="button" variant="outline" disabled={aiBusy || !content} data-testid="ai-refine"
                      onClick={() => void runRefine(refineText)}>
                      Refine
                    </Button>
                    {preview && preview.errorCount > 0 && (
                      <Button type="button" variant="ghost" disabled={aiBusy} data-testid="ai-fix-errors"
                        onClick={() => void runRefine("Fix the rows that failed to parse.")}>
                        Ask AI to fix these
                      </Button>
                    )}
                  </div>
                )}
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

function SignSelect({ sign, setSign }: {
  sign: "negativeIsDebit" | "positiveIsDebit";
  setSign: (v: "negativeIsDebit" | "positiveIsDebit") => void;
}) {
  return (
    <div className="space-y-1">
      <Label>Amount sign</Label>
      <Select value={sign} onValueChange={(v: string | null) => v && setSign(v === "positiveIsDebit" ? "positiveIsDebit" : "negativeIsDebit")}>
        <SelectTrigger data-testid="map-sign">
          <SelectValue>
            {(v: unknown) => (String(v) === "positiveIsDebit" ? "Positive = money out" : "Negative = money out")}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="negativeIsDebit">Negative = money out</SelectItem>
          <SelectItem value="positiveIsDebit">Positive = money out</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

function ColumnPick({ label, value, set, headers, testId }: {
  label: string; value: string; set: (v: string) => void; headers: string[]; testId: string;
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Select value={value} onValueChange={(v: string | null) => v && set(v)}>
        <SelectTrigger data-testid={testId}><SelectValue placeholder="Select column" /></SelectTrigger>
        <SelectContent>
          {headers.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck the web app (this is the strict gate per CLAUDE.md)**

Run: `cd apps/web && bun run build`
Expected: build succeeds (tsgo strict typecheck passes). If Eden complains that `api.imports.extract` doesn't exist, the API route from Task 7 isn't exported — confirm Task 7 is committed and `App` type re-exports it.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/import-dialog.tsx
git commit -m "feat(web): PDF import in the dialog (extract → regex mapping → preview → review)"
```

---

## Task 9: E2E journey + final verification

**Files:**
- Create: `e2e/tests/import-pdf.spec.ts`
- Modify: `e2e/README.md` (add the spec to the coverage table)

- [ ] **Step 1: Write the PDF journey spec**

Create `e2e/tests/import-pdf.spec.ts`. It seeds a PDF parser via the API (avoiding hand-typed regex and AI), uploads the committed fixture PDF, confirms detection, then reviews and commits:

```typescript
import { test, expect } from "./fixtures";
import { seedHousehold, createAccount } from "./helpers";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PDF_PATH = join(import.meta.dir, "../../apps/api/src/lib/import/fixtures/sample-statement.pdf");

const PDF_PARSER = {
  id: "dbs-pdf",
  name: "DBS PDF",
  sourceFormat: "pdf",
  origin: "manual",
  config: {
    version: 1, format: "pdf",
    region: { startAfter: "Transaction Details", stopAt: "Closing Balance" },
    transactionLine: "^(?<date>\\d{2}/\\d{2}/\\d{4})\\s+(?<description>.+?)\\s+(?<amount>-?[\\d,]+\\.\\d{2})$",
    date: { format: "DD/MM/YYYY" },
    amount: { decimal: ".", thousands: ",", sign: "negativeIsDebit" },
  },
  fingerprint: { format: "pdf", markers: ["dbs bank statement of account", "transaction details", "page 1 of 1"] },
};

test.beforeEach(async ({ backend, request, context }) => {
  await backend.freshDb();
  await seedHousehold(request, context, backend.apiURL);
  // Seed a saved PDF parser so detection matches on upload (authed via injected cookie).
  await request.post(`${backend.apiURL}/api/import-parsers`, { data: PDF_PARSER });
});

test("import a PDF statement into an account", async ({ page }) => {
  await page.goto("/");
  await createAccount(page, { name: "Checking", currency: "USD" });
  await page.reload();
  await page.getByTestId("account-row").filter({ hasText: "Checking" }).click();
  await expect(page).toHaveURL(/\/accounts\//);

  await page.getByRole("button", { name: "Import statement" }).click();
  const dialog = page.getByRole("dialog");

  await dialog.getByTestId("import-file").setInputFiles({
    name: "stmt.pdf", mimeType: "application/pdf", buffer: readFileSync(PDF_PATH),
  });

  // The seeded parser should be auto-selected as a confident match.
  await expect(dialog.getByTestId("import-parser")).toContainText("DBS PDF");

  await dialog.getByTestId("import-run").click();

  await expect(dialog.getByTestId("import-row")).toHaveCount(2);
  await dialog.getByTestId("import-commit").click();
  await expect(dialog).toBeHidden();

  await page.getByRole("tab", { name: "History" }).click();
  await expect(page.getByText("SALARY")).toBeVisible();
  await expect(page.getByText("COFFEE BEAN")).toBeVisible();
});
```

- [ ] **Step 2: Run the affected E2E specs**

Run: `bun run e2e -- import.spec.ts import-ai.spec.ts import-pdf.spec.ts`
Expected: all green. If `import-parser` doesn't show "DBS PDF", check that `/api/import-parsers` accepted the seed (the marker fingerprint must overlap with `fingerprintPdf` of the extracted text by ≥0.6).

- [ ] **Step 3: Add the spec to the E2E coverage table**

In `e2e/README.md`, add a row to the "What's covered" table:

```markdown
| `import-pdf` | upload a text PDF → saved parser auto-detected → review → commit → history |
```

- [ ] **Step 4: Full API test suite + web typecheck**

Run: `cd apps/api && bun test`
Expected: PASS.

Run: `cd apps/web && bun run build`
Expected: PASS (strict typecheck, no `as any`).

- [ ] **Step 5: Commit**

```bash
git add e2e/tests/import-pdf.spec.ts e2e/README.md
git commit -m "test(e2e): PDF statement import journey"
```

---

## Self-Review

**Spec coverage** (against `2026-06-15-pdf-parser-synthesis-design.md`):
- §1 Text extraction front-step → Task 4 (`extractPdfText`). Decision A confirmed (unpdf).
- §2 PDF vocabulary (Tier 1) → Task 1 (types/validate) + Task 2 (engine). Decision B = Tier 1 only; `region`, `transactionLine`, `multiline` all implemented. Amount/date reuse `parseAmountToMinor`/`parseDate` verbatim (Task 2).
- §3 AI synthesis → Task 5 (`synthesizePdfConfig`/`refinePdfConfig`, capped sample, PDF prompt) + Task 6 (route routing).
- §4 Fingerprint/detection → Task 3 (`fingerprintPdf`/`matchPdfParsers`) + Task 7 (extract endpoint ranks saved parsers); `validateFingerprint` extended (Task 1).
- §5 Upload/endpoints (binary) → Task 7 (`/imports/extract`, base64). Decision C = extract-once/reuse-text-path; import is format-aware.
- §6 Pipeline integration unchanged → Task 7 reuses existing staging/dedup/commit; verified no changes needed.
- Data model → no new tables (uses `import_parsers` with `sourceFormat:"pdf"`); confirmed schema already supports it.
- Error taxonomy → `pdf_no_text` + `pdf_encrypted` (Task 4 + Task 7 mapping to 422); `ai_invalid_output`/`ai_unavailable` reused (Task 5/6).
- Security/ReDoS → `assertSafeRegex` (Task 1), capped sample (Task 5), AI output validated before use (Task 5/6).
- Testing → engine unit tests (Task 2), extraction fixture test (Task 4), synth/refine/preview route tests (Task 6), fingerprint scoring (Task 3), ReDoS guard (Task 1), e2e (Task 9), web typecheck gate (Task 8/9).
- Out of scope (OCR/Tier 2/brokerage) → correctly excluded.

**Type consistency:** `PdfParserConfig` (named groups `date`/`amount` required, `description` optional; no `group` indirection — simplified from the spec's example since named groups already carry the names) is used identically across `validate.ts`, `pdf.ts`, `ai.ts`, routes, and the dialog. `runPdfParser(text, config, currency)` signature is identical in engine, preview route, and import route. `PdfFingerprint { format, markers }` consistent across `detect.ts`, `validate.ts`, extract route, and dialog save. `extractPdfText`/`PdfExtractError`/`classifyPdfError` names consistent between Task 4 and Task 7.

**Placeholder scan:** no TBD/"add error handling"/"similar to" — every code step is complete. The two spots that say "match the existing file's pattern" (Task 7 account-create payload) are deliberate: the engineer must mirror the sibling CSV tests already in `imports.test.ts` rather than guess a payload shape — verify against that file when implementing.
