# External Data Import — Design

**Date:** 2026-06-15
**Status:** Approved (design); roadmap of 5 specs, this doc covers the arc + details Spec 1.

## Goal

Let users bring financial data in from outside the app — bank statements, credit-card
statements, and (later) brokerage statements — and map each line to `uang`'s ledger.

The defining idea: the LLM does not parse documents on every upload. Instead, for an
unrecognized format the AI **synthesizes a reusable, declarative parser** (e.g. "DBS
Statement Parser"). That config is saved and future uploads of the same format are
**auto-detected and parsed deterministically** — fast, free, private, reproducible, and
auditable. AI becomes a one-time "teach the app this format" step, not a per-document
dependency.

## Key constraints (decisions made during brainstorming)

- **Self-hostable AI = A + C optional.** The app must work fully with **zero external
  calls**. Deterministic parsers are the product; the LLM is an *optional enhancement*
  that can point at a **local** OpenAI-compatible model (Ollama / llama.cpp / LM Studio)
  or a **cloud BYO-key** provider. Default is AI off (`none`).
- **Parsers are declarative config, not code (option A).** No execution of AI-generated
  code. The AI emits structured rules validated against a JSON schema; the engine
  interprets them. Safe by construction, inspectable, diffable.
- **Parsers are first-class, user-editable entities.** AI synthesis is just one way to
  produce a config; a human can author one from scratch or correct AI output in a form.
- **Detection = suggest, user confirms (option B).** Confident match → suggested for
  one-click confirm; user can pick a different parser or create new. Opt-in settings
  toggle "auto-apply confident matches" graduates power users to zero-click.
- **Mapping is ledger-only now, category seam reserved (option C).** Each statement line
  becomes a cash transaction; `category` is reserved in the canonical row but unused. No
  budgeting/categorization UI in v1.

## Non-goals (YAGNI)

- Categorization / budgeting UI (data seam reserved only).
- Brokerage import in v1 (own later spec; row schema reserves fields for it).
- Scheduled / automatic live bank syncing (Plaid-style connections).
- Splitting one file across multiple accounts.
- Parser sharing / marketplace (export/import of configs may come, but no marketplace).

---

## Architecture — the spine

A single import pipeline; parsers and the AI are pluggable pieces.

```
upload file
  → FINGERPRINT  (cheap signal extraction: headers / OFX FI id / PDF text markers)
  → DETECT       (match fingerprint against saved parsers → ranked candidates)
  → [no match]   → AI SYNTHESIS → draft parser config → user reviews/edits → save
  → [match]      → suggest parser (B): user confirms / picks / creates
  → PARSE        (deterministic: run the declarative config over the file → ImportRows)
  → STAGE        (rows land in a staging table, tagged new / duplicate / needs-input)
  → REVIEW       (user sees rows, fixes mappings, toggles which to import)
  → COMMIT       (staged rows → real transactions, transactionally)
```

The AI appears only at synthesis, only for unrecognized formats. Everything after "save
parser" runs deterministically with AI fully disabled.

## Data model (new tables)

`transactions` is unchanged except for one added optional column for traceability.

### `import_parsers` — the reusable, user-editable config
- `id` (text, pk)
- `name` (text) — e.g. "DBS Statement Parser"
- `sourceFormat` (text) — `csv | ofx | qif | pdf`
- `config` (text, JSON) — the declarative rules (see below)
- `fingerprint` (text, JSON) — detection signature
- `origin` (text) — `ai | manual`
- `createdAt` (int), `createdBy` (text)

### `import_batches` — one per uploaded file
- `id` (text, pk)
- `parserId` (text) — logical FK → import_parsers.id
- `accountId` (text) — target account
- `filename` (text)
- `fileHash` (text) — hash of raw file; short-circuits exact re-uploads
- `status` (text) — `parsing | review | committed | discarded`
- `rowCountNew` / `rowCountDuplicate` / `rowCountError` (int)
- `createdAt` (int), `createdBy` (text)

### `import_rows` — staged canonical rows
- `id` (text, pk)
- `batchId` (text) — FK → import_batches.id
- `raw` (text, JSON) — original parsed payload, for audit
- `date` (text, YYYY-MM-DD)
- `amountMinor` (int, signed) — normalized ledger amount
- `description` (text)
- `category` (text, nullable) — **reserved, unused in v1**
- `dedupHash` (text)
- `status` (text) — `new | duplicate | excluded | error`
- `errorReason` (text, nullable)
- `matchedTxnId` (text, nullable) — existing txn this duplicates
- `committedTxnId` (text, nullable) — set on commit

### `transactions` (modified)
- add `importBatchId` (text, nullable) — traceability + enables un-import of a batch.

## Declarative parser config (the heart of option A)

A versioned JSON vocabulary the engine interprets. The vocabulary starts minimal and grows
only when a real statement demands it. Every field is human-readable and editable.

```jsonc
{
  "version": 1,
  "format": "csv",
  "detect": { /* fingerprint, see Detection */ },
  "csv": { "delimiter": ",", "headerRow": 0, "skipRows": 0, "encoding": "utf-8" },
  "fields": {
    "date":        { "column": "Transaction Date", "format": "DD MMM YYYY" },
    "description": { "column": "Description" },
    "amount": {
      "mode": "single",            // or "debitCredit" (two columns)
      "column": "Amount",
      "decimal": ".", "thousands": ",",
      "sign": "negativeIsDebit"    // how raw sign maps to ledger direction
    }
  },
  "rowFilter": { "dropIfBlank": ["date", "amount"] }
}
```

- **PDF**: same envelope with a `pdf` block (text-anchor / table-region / regex line rules)
  in place of `csv`.
- **OFX / QIF**: config is thin — these formats are self-describing; the parser maps
  standard fields and the config mostly records detection + any overrides.

The engine validates any config (AI- or human-authored) against this schema before it is
saved or run.

## AI synthesis — self-hostable (A + C optional)

A single provider interface:

```
synthesizeParser(sample: ExtractedText, hint?: string) → ParserConfig   // schema-validated
```

Adapters, selected by config (env/settings):
- **`none`** (default) — AI off. Import works fully via manual parser authoring.
- **`local`** — any OpenAI-compatible endpoint (Ollama / llama.cpp / LM Studio). Zero
  external calls.
- **`cloud`** — BYO key (Anthropic / OpenAI).

Safety properties:
- The model never touches the ledger.
- Its output is **untrusted**: must validate against the config JSON schema; the user
  reviews/edits before it is saved or run. A bad response degrades to "fill the form
  yourself," never to corrupt data.
- Synthesis runs server-side and is sent a **redacted sample** (structure + a few example
  lines). The UI flags that enabling `cloud` sends sample statement text to that provider.

## Detection / matching (option B)

Each parser stores a `fingerprint`; matching is per-format:
- **CSV** → normalized header-column set (order-insensitive) + delimiter. Exact-ish.
- **OFX / QFX** → embedded FI org/id. Exact.
- **PDF** → set of stable marker strings (issuer name, anchor phrases) → fuzzy score with
  a confidence threshold.

On upload: rank candidates, **suggest the top one for one-click confirm**; "use a different
parser" and "create new (AI)" always available. Settings toggle "auto-apply confident
matches" enables zero-click. No match → synthesis flow. `fileHash` short-circuits exact
re-uploads of the same file.

## Dedup (financial correctness — non-negotiable)

Every staged row gets a `dedupHash`:
- **OFX / QIF** → bank `FITID` when present (authoritative).
- **CSV / PDF** → `hash(accountId, date, amountMinor, normalizedDescription)`.

At stage time, check the hash against (a) committed `transactions` for that account and
(b) other rows in the batch. Matches are marked `duplicate` and **excluded by default** in
review (user can override). Makes overlapping statement periods safe to re-import.

## Commit mapping

- **Bank / credit-card (v1):** each included row → one transaction on the account's
  currency instrument (`ensureCurrencyInstrument(account.currency)`):
  `unitsDelta = amountMinor scaled to ×1e8` (signed; credit-card liability spend is
  negative), `unitPriceScaled = SCALE` (cash priced at 1.0), `notes = description`,
  `importBatchId` set. Commit inserts all included rows; partial failure rolls the batch
  back to `review`.
- **Brokerage (later spec):** row → instrument-resolved buy/sell + cash leg + corporate
  actions. The ImportRow schema reserves `instrumentSymbol`, `units`, `unitPrice`,
  `legType` so this is an extension, not a rewrite.

## Review UI

Per-batch table review screen: rows grouped by status (new / duplicate / error),
inline-editable mapped fields, per-row include toggle, a "fix parser" link (re-run after
editing config), and a Commit button showing "N new, M duplicates skipped." shadcn
components added via the shadcn CLI (project convention).

## Testing

- Spine + parsers are pure functions over fixture files (real anonymized CSV/OFX/PDF
  samples) → deterministic unit tests, no AI in the loop.
- Dedup, sign handling, date formats, and commit mapping each get fixture-driven tests.
- AI synthesis tested against the **schema validator** (does output parse?) with the model
  mocked.
- Typecheck via `cd apps/web && bun run build` (tsgo); `bun test` does not strict-typecheck.
- Strict project rule: **no `as any`** — model types correctly.

---

## Roadmap — decomposition into specs (build order)

Each ships independently on top of the spine.

1. **Spec 1 — Import spine + CSV parser + review/commit + dedup.** End-to-end value
   (manual CSV import) with **no AI**. First implementation plan.
2. **Spec 2 — OFX/QFX + QIF parsers.** Reuse spine; best dedup via FITID.
3. **Spec 3 — AI synthesis layer.** Provider adapters (`none`/`local`/`cloud`); turns
   "create new parser" into magic.
4. **Spec 4 — PDF parsing.** Deterministic text extraction; pairs with Spec 3 for
   arbitrary layouts.
5. **Spec 5 — Brokerage adapter.** Instrument resolution, cash legs, corporate actions.

Next step: write the implementation plan for **Spec 1**.
