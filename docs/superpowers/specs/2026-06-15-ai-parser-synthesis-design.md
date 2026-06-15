# AI Parser Synthesis — Design (Spec 3 + north star)

**Date:** 2026-06-15
**Status:** Approved (design). Spec 3 is the first build; the north-star section records the
end-state the whole arc converges on.
**Builds on:** Spec 1 (import spine + CSV) — `docs/superpowers/specs/2026-06-15-external-data-import-design.md`.

---

## North star — "drop any document"

### The one principle

**The AI's only job, ever, is to author a deterministic, declarative parser. It never
extracts rows directly.** Every document — CSV, XLSX, OFX, text PDF, scanned PDF, photo —
is turned into transactions by a *saved* deterministic parser. The AI is invoked **once per
format** to write (or refine) that parser; it is never invoked per *document*. A synthesized
parser is validated against the document, **saved and fingerprinted immediately**, and then
runs deterministically for that document and every future one whose fingerprint matches.

Consequences:
- **One mechanism** for all formats: a saved declarative parser. No throwaway extractions,
  no non-deterministic imports.
- **Self-improving and cheap.** First encounter with a format = one model call to author the
  parser. Every subsequent matching document is detected by fingerprint and parsed for free,
  on-box, instantly. "Refine with AI" edits-and-re-saves the same parser, so it improves with
  use.
- **Reusable by construction**, which is the requirement: synthesize → save → reuse for the
  session and all future matching documents.

### The unified pipeline

```
   drop ANY document
          │
   ┌──────▼───────┐   structured (CSV/TSV/XLSX/OFX): read directly
   │  to TEXT     │   text PDF: extract text (deterministic library)
   │  layer       │   scan / photo: OCR  ← only non-LLM per-document step, local & on-box
   └──────┬───────┘
   ┌──────▼───────┐
   │  FINGERPRINT │   headers / FI id / PDF issuer + anchor strings / layout markers
   └──────┬───────┘
   ┌──────▼───────────────────────────┐
   │ matching saved parser?            │
   └───┬───────────────────────────┬───┘
      yes                           no
       │              ┌─────────────▼──────────────┐
       │              │ AI SYNTHESIZES a parser     │  (one model call, per format)
       │              │  → validate by running it    │
       │              │    against THIS document     │
       │              │  → SAVE + fingerprint        │
       │              └─────────────┬───────────────┘
       └──────────────┬─────────────┘
            ┌──────────▼───────────┐
            │ run parser → rows     │  deterministic
            │ REVIEW + live preview │  "Refine with AI" edits & re-saves the parser
            │ + dedup               │
            └──────────┬───────────┘
                    COMMIT → transactions
```

### Document types → path

| Document | First encounter | Every later one |
|---|---|---|
| CSV / TSV / XLSX | AI synthesizes config | detected → parse, free & on-box |
| OFX / QFX / QIF | self-describing (little/no AI) | detected → parse, free & on-box |
| Text PDF | AI synthesizes text/region rules | detected → parse, free & on-box |
| Scanned PDF / photo | OCR → AI synthesizes rules over OCR text | detected → OCR (local) → parse |
| Brokerage statement | AI synthesizes config + instrument/cash-leg mapping | detected → parse |

### The one honest constraint

A deterministic parser needs **text** to apply rules to. Structured files and **text PDFs**
are fully deterministic after synthesis — nothing leaves the box on reuse. **Scanned PDFs and
photos** have no text layer, so they need an **OCR front-step** before the parser runs. OCR
runs on every such document (it is reading new numbers), but it is a **local, deterministic
engine** (e.g. Tesseract) — no LLM per document, nothing sent to a cloud. The AI still only
authors the parser once. OCR is the price of pixels; the principle holds.

A wildly variable layout may occasionally need a "Refine," but that always produces an
**updated saved parser**, never a per-document extraction. If a format ever exceeds what the
declarative vocabulary can express, the fallback to a sandboxed generated function (the
original brainstorm's option B/C) is revisited then — not now.

### Roadmap toward the north star (each its own spec, on Spec 1's engine)

1. **Spec 3 (this doc)** — AI substrate (provider settings, OpenAI-compatible adapter,
   synthesize / refine / preview endpoints, dialog integration) **+ CSV synthesis + Refine
   loop**. The keystone everything else reuses.
2. **Spec 4** — PDF deterministic parse mode (text extraction + anchor/region/regex rule
   vocabulary) + AI synthesis for text PDFs.
3. **Spec 5** — OCR front-step + vision-assisted synthesis for scanned PDFs / photos.
4. **Spec 6** — brokerage synthesis (instrument resolution + cash legs).
5. (Spec 2 OFX/QIF slots in alongside.)

Nothing in the later specs changes Spec 3's substrate; they add new parse modes behind the
same `Extractor` interface and reuse the same settings/adapter/endpoints/review UI.

---

## Spec 3 — detailed design (the first build)

**Goal:** When AI is configured, a user can drop a CSV, click **Generate with AI**, get a
draft parser config that pre-fills the (editable) mapping form, see a **live preview** of the
parsed rows, **Refine with AI** in plain language until the preview is right, then save — all
on the deterministic engine from Spec 1. CSV-only; the AI authors a `CsvParserConfig`.

### Scope

- In: provider config in Settings; one OpenAI-compatible adapter; `synthesize`, `refine`,
  `preview` endpoints; drop-zone upload; AI-prefill of the mapping form; live preview; Refine
  (free-text + error-aware "fix these") loop.
- Out (their own specs): PDF/XLSX/OFX/image, OCR, vision, per-format rule vocabularies,
  brokerage. No streaming, no chat history, no auto-apply-without-review, no multi-sample
  tuning, no retry/repair loops beyond user-driven Refine.

### Configuration (Settings UI, option B)

Extend the `settings` singleton (`apps/api/src/db/schema.ts`) with three nullable columns:
- `aiBaseUrl` (text) — e.g. `http://localhost:11434/v1` (Ollama) or `https://api.openai.com/v1`.
- `aiModel` (text) — e.g. `gpt-4o-mini`, `llama3.1`, a Claude model via a compat endpoint.
- `aiApiKey` (text) — optional (local runners often need none).

**"AI enabled" ⇔ `aiBaseUrl` and `aiModel` are both non-empty.**

Settings route (`apps/api/src/routes/settings.ts`):
- `GET /settings` returns `aiBaseUrl`, `aiModel`, and **`aiApiKeySet: boolean`** — never the
  raw key.
- `PATCH /settings` accepts `aiBaseUrl`, `aiModel`, `aiApiKey`. An **omitted or empty**
  `aiApiKey` leaves the stored key unchanged; a sentinel (e.g. explicit empty-clear) is out of
  scope — to clear, the user can blank base URL/model to disable. (Self-hosted: key stored in
  DB in plaintext is acceptable per project owner; it is simply never returned to the client.)

Settings UI (`apps/web/src/routes/settings.tsx`): a **"Smart import (AI)"** section with the
three fields (API key shown as a password field with a "key is set" hint), a short privacy
note (a cloud base URL sends sample statement text to that provider; a local URL keeps it on
the box), and a **"Test connection"** button → `POST /settings/ai/test` that does a 1-token
ping and reports ok / the error string.

### The adapter (single OpenAI-compatible client, option A)

`apps/api/src/lib/import/ai.ts`:

```ts
interface AiConfig { baseUrl: string; model: string; apiKey?: string }

// One low-level call: OpenAI-compatible POST {baseUrl}/chat/completions with
// response_format: { type: "json_object" }. Returns the parsed JSON object (unknown).
async function chatJson(cfg: AiConfig, system: string, user: string): Promise<unknown>

// Author a CSV parser config from a sample. Builds the prompt (headers + first ~20 rows +
// the CsvParserConfig JSON shape), calls chatJson, then runs validateParserConfig on the
// result. Throws "ai_invalid_output" if the model's JSON fails validation.
async function synthesizeCsvConfig(sample: string, cfg: AiConfig): Promise<CsvParserConfig>

// Refine an existing config: same as synthesize but the prompt also includes the current
// config, the user's natural-language instruction, and the current preview's error
// rows/reasons. Returns a new validated CsvParserConfig.
async function refineCsvConfig(
  sample: string,
  current: CsvParserConfig,
  instruction: string,
  errors: Array<{ raw: Record<string,string>; reason: string }>,
  cfg: AiConfig,
): Promise<CsvParserConfig>
```

Properties: AI output is **untrusted** — it is always run through `validateParserConfig`
(Spec 1) before returning, and always shown to the user (form + preview) before it is saved
or run. A bad response degrades to "edit the form yourself," never to corrupt data. The
adapter is pure transport + prompt + validate; it never touches the DB or the ledger.

**Sample cap:** headers + first 20 data rows, hard-capped (e.g. 8 KB) to bound tokens and the
amount of statement text sent to a provider.

### Endpoints (all authGuard; `apps/api/src/routes/import-parsers.ts`)

- `POST /import-parsers/synthesize` — body `{ content }`. Loads settings; if AI disabled →
  `422 { error: "ai_not_configured" }`. Calls `synthesizeCsvConfig`. On model/network failure
  → `502 { error: "ai_unavailable", message }`; on unvalidatable output →
  `422 { error: "ai_invalid_output" }`. Success → `{ config }`.
- `POST /import-parsers/refine` — body `{ content, config, instruction, errors? }`. Same error
  taxonomy; success → `{ config }`.
- `POST /import-parsers/preview` — body `{ content, config }`. Validates the config, runs the
  real `parseCsv(content, config, currency)` against the account's currency, returns the first
  ~5 `CanonicalRow`s + counts `{ rows, total, errorCount }`. **No client-side parsing fork** —
  reuses the Spec 1 engine. (Account currency: accept `currency` in the body, defaulting to the
  household base; the dialog passes the account's currency.)
- `POST /settings/ai/test` (in `settings.ts`) — 1-token ping using the stored or
  just-submitted AI config → `{ ok: true }` or `{ ok: false, message }`.

`synthesize`/`refine` set `origin: "ai"` when the resulting parser is eventually saved
(existing `import_parsers.origin` column); manual edits before save keep it as the user's.

### Dialog UX (`apps/web/src/components/import-dialog.tsx`)

```
┌ Import statement ───────────────────────────────────────┐
│  ┌───────────────────────────────────────────────────┐  │
│  │        ⬆   Drop your statement here                │  │  drag-and-drop OR click;
│  │            or click to browse  (.csv)              │  │  shows filename once added
│  └───────────────────────────────────────────────────┘  │
│  Parser: [ Demo Bank CSV (match) ▾ ]                     │
│  ── or ── Create a new parser        [ ✨ Generate with AI ] │  (shown only when AI enabled)
│                                                          │
│  Date [Date ▾]  Format [YYYY-MM-DD]                      │  form: AI-prefilled & editable
│  Description [Description ▾]                              │
│  Amount [Amount ▾]  Sign [Negative = money out ▾]        │
│                                                          │
│  Refine: [ "dates are DD/MM, skip the first row" ] [Refine]│  free-text → /refine
│                                                          │
│  Preview                                  3 ok · 0 errors│  live, from /preview (debounced)
│   2026-02-01  COFFEE BEAN        −4.50                   │
│   2026-02-03  SALARY FEB      3,000.00                   │
│   …                                                      │
│  ⚠ 2 rows failed to parse   [ Ask AI to fix these ]      │  appears only when errorCount>0
│                                         [ Parse & review ]│
└──────────────────────────────────────────────────────────┘
```

- **Drop zone** replaces the bare file input: a dashed target that accepts drag-drop or click,
  reads the file as text, shows the filename. CSV only for this spec.
- **"✨ Generate with AI"** — visible only when AI is enabled (from `GET /settings`
  `aiApiKeySet`/base+model presence). Click → spinner → `POST /synthesize` → fills the form
  fields. On failure: a toast with the error; the manual form stays usable.
- **Live preview** — under the form, the first ~5 parsed rows + ok/error counts, refreshed
  (debounced ~400 ms) via `POST /preview` whenever the mapping changes (AI fill, refine, or
  manual edit). This is the "see it's right before committing" surface.
- **Refine (option B)** — a text box + **Refine** button calling `POST /refine` with the
  current config + instruction + the preview's current error rows; the returned config
  re-fills the form and preview. Repeatable. When `errorCount > 0`, a one-click
  **"Ask AI to fix these"** sends the error rows with an implicit instruction (no typing
  needed).
- **Parse & review** is unchanged from Spec 1 (saves the parser, stages rows, opens review).

### Error taxonomy (surfaced as toasts / inline)

| Condition | HTTP | UI |
|---|---|---|
| AI not configured | 422 `ai_not_configured` | hide the AI button (shouldn't occur) |
| Model/network down | 502 `ai_unavailable` | toast: "AI provider unreachable — check Settings" + manual form |
| Output fails validation | 422 `ai_invalid_output` | toast: "Couldn't read the AI's answer — try Refine or map manually" |
| Preview parse error rows | 200 (rows w/ errors) | inline ⚠ + "Ask AI to fix these" |

### Security & privacy

- API key stored in the DB (self-hosted), **never returned to the client**; password input.
- Cloud base URL ⇒ the sample (headers + ≤20 rows) is sent to that provider — **stated in the
  Settings section**. Local base URL ⇒ stays on the box.
- Sample is capped; the full file is never sent to the model (only the sample for synthesis;
  parsing/commit are fully local).
- AI output validated before use; cannot reach the ledger unreviewed.

### Testing

- `ai.ts` — unit tests with the HTTP client **mocked**: asserts request shape
  (baseUrl/model/auth header/json mode), that a valid model JSON → a valid `CsvParserConfig`,
  and that garbage JSON → `ai_invalid_output`. No real network.
- `synthesize`/`refine` routes — fixture tests with the adapter mocked (inject/replace the
  chat call): disabled→422, unreachable→502, bad output→422, good→`{ config }`.
- `preview` route — real `parseCsv` over fixtures: returns first-N rows + counts; bad config →
  422.
- Settings AI fields — round-trip; **key-not-leaked** test (`GET` returns `aiApiKeySet`, not
  the key); `PATCH` with empty key preserves the stored one.
- Typecheck via `cd apps/web && bun run build`. e2e: the deterministic drop→map→preview→
  review→commit path (AI button exercised with the network mocked, or left to unit coverage).
- Project rule: **no `as any`** (Elysia ctx `: any` excepted).

### Files

- Modify: `apps/api/src/db/schema.ts` (+3 settings columns; migration), `apps/api/src/routes/settings.ts` (AI fields, `aiApiKeySet`, `/settings/ai/test`), `apps/api/src/routes/import-parsers.ts` (synthesize/refine/preview), `apps/web/src/routes/settings.tsx` (AI section), `apps/web/src/components/import-dialog.tsx` (drop zone, AI button, refine, live preview).
- Create: `apps/api/src/lib/import/ai.ts` (+ `ai.test.ts`), route tests, a `DropZone` web component (or inline).
- Unchanged: the Spec 1 engine, `validateParserConfig`, `parseCsv`, staging/dedup/commit, `import_parsers` table (reused; `origin: "ai"`).
