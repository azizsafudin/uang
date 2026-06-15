# Text-PDF Parsing + AI Synthesis — Design (Spec 4)

**Date:** 2026-06-15
**Status:** Planned. All three Open Decisions resolved (2026-06-15) and the implementation plan is
written at `docs/superpowers/plans/2026-06-15-pdf-parser-synthesis.md`. Resolutions:
- **A (PDF library):** `unpdf@1.6.2`. Empirically verified under Bun — `extractText(bytes, {mergePages:false})`
  works; **positioned items (`getTextContent`) throw `DataCloneError` under Bun**, so x/y column rules are not viable on this stack.
- **B (rule vocabulary):** Tier 1 only (line-regex + region + multiline). Tier 2 deferred (also blocked by the Bun/pdf.js limitation above).
- **C (binary transport):** Extract once, reuse the text path — `POST /imports/extract` (base64 bytes → `{text, fingerprint, candidates}`);
  client reuses the existing `content`-based synthesize/refine/preview/import with `format:"pdf"`.
**Builds on:** Spec 1 (import spine + CSV) and Spec 3 (AI parser synthesis). North star:
`docs/superpowers/specs/2026-06-15-ai-parser-synthesis-design.md` ("drop any document").

---

## Goal

Deterministically import **text-bearing PDF** bank/credit-card statements by synthesizing a
reusable declarative parser (once per format), reusing the Spec 1 staging/dedup/commit
pipeline and the Spec 3 AI substrate (provider settings, OpenAI-compatible adapter,
synthesize/refine/preview, dialog). **Scanned/image PDFs are out of scope** (they need OCR →
Spec 5). The core principle from the north star holds: the AI authors a parser, never
extracts rows; every reuse is deterministic and on-box.

## Where this fits the north star

The pipeline gains a **text-extraction front-step** for PDFs, then the same
synthesize→validate→save→reuse loop runs. After Spec 4, a recurring "DBS PDF" is fingerprinted
and parsed for free; only the first encounter calls the model. Nothing in Spec 1/3 changes
shape — Spec 4 adds a parse mode behind the existing interfaces.

```
   drop a .pdf
        │
   ┌────▼─────────────┐
   │ extract TEXT     │  pdf → text (deterministic library; positioned items available)
   └────┬─────────────┘
   ┌────▼─────────────┐
   │ FINGERPRINT      │  issuer + stable anchor strings → fuzzy match
   └────┬─────────────┘
   matching saved PDF parser?  ── yes → run rules ─┐
        │ no                                        │
   ┌────▼───────────────────────────┐              │
   │ AI synthesizes a PdfParserConfig│              │
   │  → run against THIS doc's text  │              │
   │  → save + fingerprint           │              │
   └────┬───────────────────────────┘              │
        └───────────────┬──────────────────────────┘
              run rules over text → CanonicalRow[] → stage → dedup → review (+Refine) → commit
```

---

## Architecture

### 1. Text extraction (front-step)

Introduce a small **`extractText`** step so the pipeline is `extractText(file, format) → string`
then `runParser(config, text, currency) → CanonicalRow[]`. For CSV, `extractText` returns the
raw CSV unchanged (the existing path). For PDF, it extracts the text layer.

**Open Decision A — PDF library.** Needs to run under Bun, server-side, and ideally expose
text *with positions* (x/y) so positioned-column rules are possible later.
- **Recommended:** `unpdf` (pdf.js-based, serverless/Bun-friendly, zero native deps) — gives
  page text and, via pdf.js `getTextContent`, positioned text items.
- Alternatives: `pdfjs-dist` directly (more control, heavier), `pdf-parse` (simplest, text-only,
  no positions — rules out positioned-column rules).
Confirm the choice + that it parses a real statement under Bun before planning. Password-
protected PDFs → clear error `pdf_encrypted` (out of scope to decrypt).

The extractor produces, per document: `text` (lines joined with `\n`, page breaks marked) and
optionally `items` (positioned text). Spec 4 leads with the line-based `text`; positioned
`items` are reserved for the column-rule escape hatch (Open Decision B).

### 2. The PDF parser vocabulary (declarative, extends `ParserConfig`)

Add a `format: "pdf"` variant to the config union (`apps/api/src/lib/import/types.ts`).

**Open Decision B — rule vocabulary.** Two expressiveness tiers; recommend shipping Tier 1 and
adding Tier 2 only if real statements need it (YAGNI):

**Tier 1 (recommended for v1) — line regex + region + normalization:**
```jsonc
{
  "version": 1,
  "format": "pdf",
  "region": { "startAfter": "Transaction Details", "stopAt": "Closing Balance" }, // optional anchors (regex) bounding the txn section
  "transactionLine": "^(?<date>\\d{2}/\\d{2}/\\d{4})\\s+(?<description>.+?)\\s+(?<amount>-?[\\d,]+\\.\\d{2})$",
  "fields": {
    "date":   { "group": "date", "format": "DD/MM/YYYY" },
    "description": { "group": "description" },
    "amount": { "group": "amount", "decimal": ".", "thousands": ",", "sign": "negativeIsDebit" }
  },
  "multiline": { "continuationAppendsTo": "description" } // optional: lines that DON'T match transactionLine get appended to the previous row's description
}
```
The engine: extract text → apply `region` to slice the transaction section → for each line, run
`transactionLine` (a regex with named groups) → map groups to date/description/amount, reusing
the **existing Spec 1 `parseDate` and `parseAmountToMinor`/sign handling** → emit
`CanonicalRow`. Non-matching lines are ignored (or appended per `multiline`). This covers the
large majority of text statements, is deterministic, reusable, and human-editable.

**Tier 2 (escape hatch, only if needed) — positioned columns:** rules keyed on x-position
ranges from the extractor's `items` (for tables that don't serialize to clean single lines).
More complex; defer unless Tier 1 demonstrably fails on a target statement.

The amount/date sub-objects deliberately mirror the CSV vocabulary so `parseAmountToMinor`,
`parseDate`, and the sign convention are **reused verbatim** — no new money/date logic.

### 3. AI synthesis (reuses Spec 3 substrate)

`synthesizeCsvConfig`/`refineCsvConfig` generalize to `synthesize(sample, format, cfg)` /
`refine(...)` (or add `synthesizePdfConfig`). For PDF: the server extracts text, sends a capped
sample (first ~2 pages / ~8 KB of text) to the model with the `PdfParserConfig` JSON shape, gets
back rules, validates them with the extended `validateParserConfig`, and (as in Spec 3) the
client sees the result before save. The **Refine** loop is unchanged — the model gets the
current config + instruction + failing lines.

Prompt note: instruct the model to write a `transactionLine` regex with named groups
`date`/`description`/`amount`, infer the date format, choose the region anchors from visible
section headers, and pick the sign so money leaving the account is negative.

### 4. Fingerprint / detection

`PdfFingerprint { format: "pdf", markers: string[] }` — a handful of stable strings from the
text (issuer/bank name, recurring header/footer phrases), lower-cased. Matching: overlap/Jaccard
over markers with a confidence threshold (analogous to the CSV header match). `validateFingerprint`
(Spec 1) extends to accept the PDF shape. Detection routes an uploaded PDF to a saved parser
(suggest, one-click confirm) or to synthesis.

### 5. Upload + endpoints (binary handling)

PDFs are binary, so the dialog can't read them as text. Options (pick at plan time): multipart
upload, or base64 in JSON. **Recommended:** the client sends the PDF bytes (base64 or multipart);
the server extracts text per call. The server stays **stateless** about the file — nothing
persists the raw PDF or its text beyond the staged `import_rows` (consistent with Spec 1, which
never persisted CSV content). Endpoints extend to accept a PDF:
- `POST /accounts/:id/imports` — `{ filename, file (base64) | content, parserId, format }`. For
  PDF: extract text, run the parser, stage rows.
- `POST /import-parsers/synthesize` / `/refine` / `/preview` — accept the PDF bytes (or the
  already-extracted text) + `format: "pdf"`; extract once, operate on the text.
A small wrinkle: synthesize→preview→refine each re-extract text from the same bytes. Extraction
is cheap; the client holds the bytes for the dialog session and re-sends them. (Alternative:
extract once and pass the text around — decide at plan time.)

### 6. Pipeline integration (unchanged downstream)

`extractText` + `runPdfParser` produce `CanonicalRow[]`; **staging, dedup hash
(date+amount+normalized description), review, Refine, and commit are exactly Spec 1/3** — no
changes. Dedup against committed transactions works identically. `import_parsers.sourceFormat`
already includes `"pdf"`; `config`/`fingerprint` hold the PDF shapes.

---

## Data model

- No new tables. `import_parsers` reused (`sourceFormat: "pdf"`, `config` = `PdfParserConfig`,
  `fingerprint` = `PdfFingerprint`, `origin: "ai"`).
- `import_batches`/`import_rows` unchanged. (If a future need arises to re-parse without
  re-upload, consider an optional `sourceText` on the batch — **not** in Spec 4.)

## Error taxonomy (adds to Spec 3's)

| Condition | HTTP | UI |
|---|---|---|
| PDF has no text layer (scanned) | 422 `pdf_no_text` | "This looks like a scanned PDF — OCR isn't supported yet" (Spec 5) |
| Encrypted/password PDF | 422 `pdf_encrypted` | "Remove the password and re-upload" |
| Synthesis output invalid | 422 `ai_invalid_output` | as Spec 3 |
| Provider unreachable | 502 `ai_unavailable` | as Spec 3 |

## Security / privacy

- Same as Spec 3: AI output validated before use; provider config admin-only; key never returned;
  cloud base URL ⇒ sample text sent (now PDF-extracted text) — stated in Settings.
- The regex from a synthesized/edited config is compiled server-side. **Guard against ReDoS**:
  validate the `transactionLine` regex (length cap; reject nested unbounded quantifiers, or run
  matching with a per-line timeout/iteration cap). The user-supplied date `format` is already
  ReDoS-safe (Spec 1 fixed-width tokens). Treat the synthesized regex as untrusted input.
- Cap extracted-text sample sent to the model (≈8 KB / first ~2 pages).

## Testing

- **Rule engine** (`runPdfParser`): unit-tested over **plain text fixtures** (no PDF needed) —
  region slicing, `transactionLine` named-group extraction, multiline continuation, date/amount
  reuse, non-matching lines ignored.
- **Text extraction**: one tiny committed fixture PDF → asserts known text/lines extracted.
- **Synthesis/refine/preview** for PDF: adapter mocked (Spec 3 pattern) + the mock-AI server;
  assert format routing + validation.
- **Fingerprint/detection**: marker overlap scoring.
- **ReDoS guard**: a pathological regex is rejected/limited.
- **e2e**: upload a fixture text PDF → (manual or AI) map → preview → review → commit.
- Typecheck via `cd apps/web && bun run build`. No `as any` (Elysia ctx excepted).

## Out of scope (later specs)

- Scanned/image PDFs + OCR + vision synthesis (Spec 5).
- Positioned-column rules (Tier 2) unless Tier 1 fails on a real target.
- Brokerage PDFs / instrument resolution (Spec 6).
- Multi-currency-per-statement, running-balance reconciliation, multi-account PDFs.

## File map (for the planner)

- Likely **create:** `apps/api/src/lib/import/pdf-text.ts` (extractText via the chosen lib),
  `apps/api/src/lib/import/pdf.ts` (`runPdfParser(config, text, currency)` + fingerprint), tests.
- Likely **modify:** `types.ts` (add `PdfParserConfig`/`PdfFingerprint` to the unions),
  `validate.ts` (validate PDF config + fingerprint, incl. ReDoS guard), `ai.ts` (PDF synth/refine
  prompt + format routing), `routes/import-parsers.ts` (format-aware synthesize/refine/preview),
  `routes/imports.ts` (PDF upload + extract + stage), `detect.ts` (PDF matching),
  `import-dialog.tsx` (accept .pdf in the drop zone; PDF mapping fields / regex display),
  `import-parsers` CRUD (already format-agnostic).

## Open Decisions to confirm before planning

1. **PDF library** (Decision A): confirm `unpdf` parses a representative statement under Bun and
   exposes positioned items; else pick `pdfjs-dist`.
2. **Rule vocabulary** (Decision B): ship Tier 1 (line-regex + region) only? Confirm on 1–2 real
   target statements that single-line regex captures their transactions; decide multiline default.
3. **Binary transport**: base64-in-JSON vs multipart for PDF upload, and whether to extract text
   once (pass text around) or re-extract per call.
