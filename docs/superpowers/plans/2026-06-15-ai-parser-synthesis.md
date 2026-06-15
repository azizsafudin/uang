# AI Parser Synthesis (Spec 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When AI is configured (Settings), let a user drop a CSV, click **Generate with AI** to get a draft parser config that pre-fills the editable mapping form, see a **live preview** of parsed rows, **Refine with AI** in plain language until it's right, then save — all on the deterministic Spec 1 engine.

**Architecture:** A single OpenAI-compatible adapter (`{ baseUrl, model, apiKey? }`, stored in the `settings` singleton) authors a `CsvParserConfig` from a CSV sample. The AI never extracts rows or touches the ledger — its JSON output is validated with the existing `validateParserConfig`, shown to the user (form + live preview via the real `parseCsv`), and only saved/run after review. CSV-only; PDF/OCR/vision are later specs.

**Tech Stack:** Bun, Elysia, Drizzle (libsql/SQLite), `@uang/shared`, React + TanStack Query/DB, shadcn/ui, Eden treaty, Playwright. OpenAI-compatible `chat/completions` with `response_format: json_object`.

**Conventions (CLAUDE.md + codebase):**
- **Never `as any`** (only tolerated: Elysia route ctx `async ({ body, set }: any) =>`). Narrow external JSON with `unknown` + specific-type assertions, never `any`.
- IDs `createId()`, time `nowEpoch()`. Route tests: `makeApp(...routes)` + `initAndLogin()` from `lib/test-helpers`, `beforeEach(resetDb)`.
- Typecheck via `cd apps/web && bun run build` (tsgo). `bun test` does not strict-typecheck.
- New routes flow into the Eden `App` type automatically.
- Money: `parseCsv(content, config, currency)` returns `CanonicalRow[]`; `currencyDecimals` from `@uang/shared`.

---

## File Structure

- **Create** `apps/api/src/lib/import/ai.ts` — `AiConfig`, `AiError`, `chatJson`, `synthesizeCsvConfig`, `refineCsvConfig`. Pure transport + prompt + validate; no DB.
- **Create** `apps/api/src/lib/import/ai.test.ts`, `apps/api/src/lib/import/ai-server.test-helper.ts` (a mock OpenAI-compatible server for route tests).
- **Modify** `apps/api/src/db/schema.ts` — `settings` += `aiBaseUrl`, `aiModel`, `aiApiKey` (nullable). Migration.
- **Modify** `apps/api/src/routes/settings.ts` — expose `aiBaseUrl`/`aiModel`/`aiApiKeySet` on GET; accept them on PATCH (empty key preserved); add `POST /settings/ai/test`.
- **Modify** `apps/api/src/routes/import-parsers.ts` — `POST /import-parsers/synthesize`, `/refine`, `/preview`.
- **Modify** `apps/web/src/routes/settings.tsx` — "Smart import (AI)" section.
- **Modify** `apps/web/src/components/import-dialog.tsx` — drop zone, "Generate with AI", live preview, Refine.
- **Create** `e2e/tests/import-ai.spec.ts` — deterministic drop→map→preview→review path.

---

### Task 1: Settings schema — AI columns

**Files:** Modify `apps/api/src/db/schema.ts`; Test `apps/api/src/db/ai-settings-schema.test.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
import { expect, test, beforeEach } from "bun:test";
import { db } from "./client";
import { settings } from "./schema";
import { eq } from "drizzle-orm";
import { resetDb } from "../lib/test-helpers";
import { nowEpoch } from "../lib/ids";

beforeEach(resetDb);

test("settings stores AI provider fields", async () => {
  await db.insert(settings).values({
    id: 1, householdName: "H", baseCurrency: "USD", createdAt: nowEpoch(),
    aiBaseUrl: "http://localhost:11434/v1", aiModel: "llama3.1", aiApiKey: "sk-x",
  });
  const [s] = await db.select().from(settings).where(eq(settings.id, 1));
  expect(s.aiBaseUrl).toBe("http://localhost:11434/v1");
  expect(s.aiModel).toBe("llama3.1");
  expect(s.aiApiKey).toBe("sk-x");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun test src/db/ai-settings-schema.test.ts`
Expected: FAIL — `aiBaseUrl` not a known column.

- [ ] **Step 3: Add the columns**

In `apps/api/src/db/schema.ts`, inside `export const settings = sqliteTable("settings", { ... })`, add before `createdAt`:

```typescript
  // Smart import (AI). "AI enabled" iff aiBaseUrl AND aiModel are both set.
  // Single OpenAI-compatible provider (local or cloud). Key is never returned to the client.
  aiBaseUrl: text("ai_base_url"),
  aiModel: text("ai_model"),
  aiApiKey: text("ai_api_key"),
```

- [ ] **Step 4: Generate the migration**

Run: `cd apps/api && bun run db:generate`
Expected: a new `apps/api/drizzle/00NN_*.sql` adding the three columns to `settings`.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/api && bun test src/db/ai-settings-schema.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/src/db/ai-settings-schema.test.ts apps/api/drizzle
git commit -m "feat(ai): add AI provider columns to settings"
```

---

### Task 2: AI adapter — `chatJson` + `synthesizeCsvConfig`

**Files:** Create `apps/api/src/lib/import/ai.ts`, `apps/api/src/lib/import/ai.test.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
import { expect, test } from "bun:test";
import { synthesizeCsvConfig, AiError, type AiConfig } from "./ai";

const cfg: AiConfig = { baseUrl: "http://x/v1", model: "m" };
const goodConfig = {
  version: 1, format: "csv", csv: { delimiter: ",", headerRow: 0, skipRows: 0 },
  fields: {
    date: { column: "Date", format: "YYYY-MM-DD" },
    description: { column: "Desc" },
    amount: { mode: "single", column: "Amount", decimal: ".", thousands: ",", sign: "negativeIsDebit" },
  },
};

test("synthesize returns a validated config from the model's JSON", async () => {
  const chat = async () => goodConfig; // injected fake chat
  const out = await synthesizeCsvConfig("Date,Desc,Amount\n2026-01-01,X,-1.00", cfg, chat);
  expect(out.fields.amount.mode).toBe("single");
});

test("synthesize rejects model output that fails config validation", async () => {
  const chat = async () => ({ version: 1, format: "csv" }); // incomplete
  await expect(synthesizeCsvConfig("x", cfg, chat)).rejects.toThrow(AiError);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun test src/lib/import/ai.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/api/src/lib/import/ai.ts`:

```typescript
import { validateParserConfig } from "./validate";
import type { CsvParserConfig } from "./types";

export interface AiConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export class AiError extends Error {
  constructor(public code: "ai_unavailable" | "ai_invalid_output", message?: string) {
    super(message ?? code);
    this.name = "AiError";
  }
}

// Extract choices[0].message.content from an OpenAI-compatible response without `any`.
function extractContent(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const msg = (choices[0] as { message?: unknown }).message;
  if (typeof msg !== "object" || msg === null) return null;
  const content = (msg as { content?: unknown }).content;
  return typeof content === "string" ? content : null;
}

// Low-level OpenAI-compatible chat call returning the parsed JSON object content.
export async function chatJson(
  cfg: AiConfig,
  system: string,
  user: string,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
      }),
    });
  } catch (e) {
    throw new AiError("ai_unavailable", e instanceof Error ? e.message : "request failed");
  }
  if (!res.ok) throw new AiError("ai_unavailable", `provider returned ${res.status}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new AiError("ai_invalid_output", "non-JSON response");
  }
  const content = extractContent(body);
  if (content === null) throw new AiError("ai_invalid_output", "missing message content");
  try {
    return JSON.parse(content);
  } catch {
    throw new AiError("ai_invalid_output", "content was not JSON");
  }
}

const CONFIG_SHAPE = `{
  "version": 1, "format": "csv",
  "csv": { "delimiter": ",", "headerRow": 0, "skipRows": 0 },
  "fields": {
    "date": { "column": "<header>", "format": "<tokens: YYYY YY MM M MMM DD D>" },
    "description": { "column": "<header>" },
    "amount": { "mode": "single", "column": "<header>", "decimal": ".", "thousands": ",", "sign": "negativeIsDebit|positiveIsDebit" }
  },
  "rowFilter": { "dropIfBlank": ["date", "amount"] }
}`;

const SYSTEM = `You convert a sample bank or credit-card CSV into a deterministic parser config.
Reply with ONLY a JSON object of exactly this shape (no prose):
${CONFIG_SHAPE}
Rules: use the real header names from the sample verbatim; infer the date format from the date
values using only the listed tokens; pick "sign" so money leaving the account is negative; if
debits and credits are in two separate columns, use {"mode":"debitCredit","debitColumn":...,
"creditColumn":...,"decimal":...,"thousands":...} instead of the single-amount shape.`;

type Chat = (cfg: AiConfig, system: string, user: string) => Promise<unknown>;
const defaultChat: Chat = (cfg, s, u) => chatJson(cfg, s, u);

export async function synthesizeCsvConfig(
  sample: string,
  cfg: AiConfig,
  chat: Chat = defaultChat,
): Promise<CsvParserConfig> {
  const raw = await chat(cfg, SYSTEM, `Sample CSV (headers + rows):\n${sample}`);
  try {
    return validateParserConfig(raw);
  } catch {
    throw new AiError("ai_invalid_output", "config failed validation");
  }
}

export async function refineCsvConfig(
  sample: string,
  current: CsvParserConfig,
  instruction: string,
  errors: Array<{ raw: Record<string, string>; reason: string }>,
  cfg: AiConfig,
  chat: Chat = defaultChat,
): Promise<CsvParserConfig> {
  const user = [
    `Sample CSV (headers + rows):\n${sample}`,
    `Current config:\n${JSON.stringify(current)}`,
    errors.length ? `Rows that failed to parse:\n${JSON.stringify(errors.slice(0, 10))}` : "",
    `Fix request: ${instruction || "Correct the rows that failed to parse."}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const raw = await chat(cfg, SYSTEM, user);
  try {
    return validateParserConfig(raw);
  } catch {
    throw new AiError("ai_invalid_output", "config failed validation");
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && bun test src/lib/import/ai.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/import/ai.ts apps/api/src/lib/import/ai.test.ts
git commit -m "feat(ai): OpenAI-compatible adapter that synthesizes/refines CSV parser configs"
```

---

### Task 3: `chatJson` transport test (mock server)

**Files:** Create `apps/api/src/lib/import/ai-server.test-helper.ts`; extend `apps/api/src/lib/import/ai.test.ts`.

- [ ] **Step 1: Write the mock-server helper**

Create `apps/api/src/lib/import/ai-server.test-helper.ts`:

```typescript
// A throwaway OpenAI-compatible server for tests. startMockAi(content) returns a server whose
// /chat/completions echoes `content` as the assistant message. Caller calls .stop().
export function startMockAi(content: unknown, opts?: { status?: number; bad?: boolean }) {
  const server = Bun.serve({
    port: 0, // ephemeral
    async fetch(req) {
      if (!req.url.endsWith("/chat/completions")) return new Response("nope", { status: 404 });
      if (opts?.status && opts.status !== 200) return new Response("err", { status: opts.status });
      if (opts?.bad) return new Response("not json", { status: 200 });
      const message = { role: "assistant", content: JSON.stringify(content) };
      return Response.json({ choices: [{ message }] });
    },
  });
  return { baseUrl: `http://localhost:${server.port}/v1`, stop: () => server.stop(true) };
}
```

- [ ] **Step 2: Write the failing test**

Append to `apps/api/src/lib/import/ai.test.ts`:

```typescript
import { chatJson } from "./ai";
import { startMockAi } from "./ai-server.test-helper";

test("chatJson posts to {baseUrl}/chat/completions and parses the JSON content", async () => {
  const mock = startMockAi({ hello: "world" });
  try {
    const out = await chatJson({ baseUrl: mock.baseUrl, model: "m" }, "sys", "usr");
    expect(out).toEqual({ hello: "world" });
  } finally {
    mock.stop();
  }
});

test("chatJson maps a 500 to ai_unavailable", async () => {
  const mock = startMockAi({}, { status: 500 });
  try {
    await expect(chatJson({ baseUrl: mock.baseUrl, model: "m" }, "s", "u")).rejects.toThrow("ai_unavailable");
  } finally {
    mock.stop();
  }
});

test("chatJson maps non-JSON content to ai_invalid_output", async () => {
  const mock = startMockAi({}, { bad: true });
  try {
    await expect(chatJson({ baseUrl: mock.baseUrl, model: "m" }, "s", "u")).rejects.toThrow("ai_invalid_output");
  } finally {
    mock.stop();
  }
});
```

- [ ] **Step 3: Run test to verify it fails, then passes**

Run: `cd apps/api && bun test src/lib/import/ai.test.ts`
Expected: the three new tests PASS (helper + adapter already implemented). If the helper file had a typo it FAILS first; fix until green.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/lib/import/ai-server.test-helper.ts apps/api/src/lib/import/ai.test.ts
git commit -m "test(ai): transport tests against a mock OpenAI-compatible server"
```

---

### Task 4: Settings route — AI fields + key hiding

**Files:** Modify `apps/api/src/routes/settings.ts`; Test `apps/api/src/routes/settings-ai.test.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
import { expect, test, beforeEach } from "bun:test";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { settingsRoutes } from "./settings";

beforeEach(resetDb);
const app = makeApp(settingsRoutes);

test("PATCH sets AI fields; GET returns aiApiKeySet not the key; empty key preserved", async () => {
  const { cookie } = await initAndLogin({ app });

  await app.handle(new Request("http://localhost/settings", {
    method: "PATCH", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ aiBaseUrl: "http://localhost:11434/v1", aiModel: "llama3.1", aiApiKey: "sk-secret" }),
  }));

  const got = await (await app.handle(new Request("http://localhost/settings", { headers: { cookie } }))).json();
  expect(got.aiBaseUrl).toBe("http://localhost:11434/v1");
  expect(got.aiModel).toBe("llama3.1");
  expect(got.aiApiKeySet).toBe(true);
  expect("aiApiKey" in got).toBe(false); // raw key never returned

  // PATCH without aiApiKey must NOT wipe the stored key
  await app.handle(new Request("http://localhost/settings", {
    method: "PATCH", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ aiModel: "llama3.2" }),
  }));
  const got2 = await (await app.handle(new Request("http://localhost/settings", { headers: { cookie } }))).json();
  expect(got2.aiApiKeySet).toBe(true);
  expect(got2.aiModel).toBe("llama3.2");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun test src/routes/settings-ai.test.ts`
Expected: FAIL — `aiBaseUrl`/`aiApiKeySet` undefined.

- [ ] **Step 3: Implement**

In `apps/api/src/routes/settings.ts`, in the GET return object add:

```typescript
      aiBaseUrl: s?.aiBaseUrl ?? "",
      aiModel: s?.aiModel ?? "",
      aiApiKeySet: !!s?.aiApiKey,
```

In PATCH, add to the `update` building (before the length check):

```typescript
      if (body.aiBaseUrl !== undefined) update.aiBaseUrl = body.aiBaseUrl || null;
      if (body.aiModel !== undefined) update.aiModel = body.aiModel || null;
      // Empty/omitted aiApiKey preserves the stored key (write-only field).
      if (typeof body.aiApiKey === "string" && body.aiApiKey.length > 0) update.aiApiKey = body.aiApiKey;
```

And extend the `body: t.Object({ ... })`:

```typescript
        aiBaseUrl: t.Optional(t.String()),
        aiModel: t.Optional(t.String()),
        aiApiKey: t.Optional(t.String()),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && bun test src/routes/settings-ai.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/settings.ts apps/api/src/routes/settings-ai.test.ts
git commit -m "feat(ai): settings route exposes/accepts AI provider fields (key write-only)"
```

---

### Task 5: `/settings/ai/test` connection ping

**Files:** Modify `apps/api/src/routes/settings.ts`; extend `apps/api/src/routes/settings-ai.test.ts`.

- [ ] **Step 1: Add the failing test**

Append to `apps/api/src/routes/settings-ai.test.ts`:

```typescript
import { startMockAi } from "../lib/import/ai-server.test-helper";

test("POST /settings/ai/test pings the configured provider", async () => {
  const { cookie } = await initAndLogin({ app });
  const mock = startMockAi({ ok: true });
  try {
    await app.handle(new Request("http://localhost/settings", {
      method: "PATCH", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ aiBaseUrl: mock.baseUrl, aiModel: "m" }),
    }));
    const res = await app.handle(new Request("http://localhost/settings/ai/test", { method: "POST", headers: { cookie } }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  } finally {
    mock.stop();
  }
});

test("POST /settings/ai/test returns ok:false when unconfigured", async () => {
  const { cookie } = await initAndLogin({ app });
  const res = await app.handle(new Request("http://localhost/settings/ai/test", { method: "POST", headers: { cookie } }));
  expect((await res.json()).ok).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun test src/routes/settings-ai.test.ts`
Expected: FAIL — route 404 / `ok` undefined.

- [ ] **Step 3: Implement**

In `apps/api/src/routes/settings.ts`, add imports:

```typescript
import { chatJson, AiError } from "../lib/import/ai";
```

Chain a new route onto `settingsRoutes` (after the PATCH):

```typescript
  .post("/ai/test", async () => {
    const s = (await db.select().from(settings).where(eq(settings.id, 1)))[0];
    if (!s?.aiBaseUrl || !s?.aiModel) return { ok: false, message: "AI is not configured" };
    try {
      await chatJson(
        { baseUrl: s.aiBaseUrl, model: s.aiModel, apiKey: s.aiApiKey ?? undefined },
        "Reply with {\"ok\":true} as JSON.",
        "ping",
      );
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e instanceof AiError ? e.message : "request failed" };
    }
  })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && bun test src/routes/settings-ai.test.ts`
Expected: PASS (4 tests in file).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/settings.ts apps/api/src/routes/settings-ai.test.ts
git commit -m "feat(ai): settings AI connection-test endpoint"
```

---

### Task 6: Synthesize + refine endpoints

**Files:** Modify `apps/api/src/routes/import-parsers.ts`; Test `apps/api/src/routes/import-parsers-ai.test.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
import { expect, test, beforeEach } from "bun:test";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { db } from "../db/client";
import { settings } from "../db/schema";
import { eq } from "drizzle-orm";
import { startMockAi } from "../lib/import/ai-server.test-helper";
import { settingsRoutes } from "./settings";
import { importParsersRoutes } from "./import-parsers";

beforeEach(resetDb);
const app = makeApp(settingsRoutes, importParsersRoutes);

const CONFIG = {
  version: 1, format: "csv", csv: { delimiter: ",", headerRow: 0, skipRows: 0 },
  fields: {
    date: { column: "Date", format: "YYYY-MM-DD" },
    description: { column: "Desc" },
    amount: { mode: "single", column: "Amount", decimal: ".", thousands: ",", sign: "negativeIsDebit" },
  },
};
const CSV = "Date,Desc,Amount\n2026-01-01,COFFEE,-4.50";

async function enableAi(cookie: string, baseUrl: string) {
  await db.update(settings).set({ aiBaseUrl: baseUrl, aiModel: "m" }).where(eq(settings.id, 1));
}

test("synthesize returns a validated config from the provider", async () => {
  const { cookie } = await initAndLogin({ app });
  const mock = startMockAi(CONFIG);
  try {
    await enableAi(cookie, mock.baseUrl);
    const res = await app.handle(new Request("http://localhost/import-parsers/synthesize", {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ content: CSV }),
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).config.fields.amount.mode).toBe("single");
  } finally { mock.stop(); }
});

test("synthesize returns 422 when AI is not configured", async () => {
  const { cookie } = await initAndLogin({ app });
  const res = await app.handle(new Request("http://localhost/import-parsers/synthesize", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ content: CSV }),
  }));
  expect(res.status).toBe(422);
  expect((await res.json()).error).toBe("ai_not_configured");
});

test("synthesize returns 502 when the provider is unreachable", async () => {
  const { cookie } = await initAndLogin({ app });
  await enableAi(cookie, "http://127.0.0.1:1/v1"); // dead
  const res = await app.handle(new Request("http://localhost/import-parsers/synthesize", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ content: CSV }),
  }));
  expect(res.status).toBe(502);
});

test("refine returns a new validated config", async () => {
  const { cookie } = await initAndLogin({ app });
  const mock = startMockAi(CONFIG);
  try {
    await enableAi(cookie, mock.baseUrl);
    const res = await app.handle(new Request("http://localhost/import-parsers/refine", {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ content: CSV, config: CONFIG, instruction: "dates are ISO", errors: [] }),
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).config.format).toBe("csv");
  } finally { mock.stop(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun test src/routes/import-parsers-ai.test.ts`
Expected: FAIL — routes 404.

- [ ] **Step 3: Implement**

In `apps/api/src/routes/import-parsers.ts`, add imports:

```typescript
import { settings } from "../db/schema";
import { synthesizeCsvConfig, refineCsvConfig, AiError, type AiConfig } from "../lib/import/ai";
```

Add a helper near the top of the file (module scope):

```typescript
async function loadAiConfig(): Promise<AiConfig | null> {
  const s = (await db.select().from(settings).where(eq(settings.id, 1)))[0];
  if (!s?.aiBaseUrl || !s?.aiModel) return null;
  return { baseUrl: s.aiBaseUrl, model: s.aiModel, apiKey: s.aiApiKey ?? undefined };
}

function aiErrorResponse(e: unknown, set: { status?: number | string }) {
  if (e instanceof AiError && e.code === "ai_invalid_output") { set.status = 422; return { error: "ai_invalid_output" }; }
  set.status = 502; return { error: "ai_unavailable", message: e instanceof Error ? e.message : "failed" };
}
```

(`eq` and `db` are already imported in this file.) Chain the routes onto `importParsersRoutes`:

```typescript
  .post(
    "/import-parsers/synthesize",
    async ({ body, set }: any) => {
      const cfg = await loadAiConfig();
      if (!cfg) { set.status = 422; return { error: "ai_not_configured" }; }
      try {
        const config = await synthesizeCsvConfig(body.content, cfg);
        return { config };
      } catch (e) {
        return aiErrorResponse(e, set);
      }
    },
    { body: t.Object({ content: t.String() }) },
  )
  .post(
    "/import-parsers/refine",
    async ({ body, set }: any) => {
      const cfg = await loadAiConfig();
      if (!cfg) { set.status = 422; return { error: "ai_not_configured" }; }
      try {
        const config = await refineCsvConfig(
          body.content, body.config, body.instruction ?? "", body.errors ?? [], cfg,
        );
        return { config };
      } catch (e) {
        return aiErrorResponse(e, set);
      }
    },
    {
      body: t.Object({
        content: t.String(),
        config: t.Unknown(),
        instruction: t.Optional(t.String()),
        errors: t.Optional(t.Array(t.Object({ raw: t.Record(t.String(), t.String()), reason: t.String() }))),
      }),
    },
  )
```

> Note: `refineCsvConfig` re-validates `body.config` indirectly only via the model output; the *incoming* `config` is passed to the prompt as-is. That's safe — it's only prompt text, and the returned config is validated. No `as any`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && bun test src/routes/import-parsers-ai.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/import-parsers.ts apps/api/src/routes/import-parsers-ai.test.ts
git commit -m "feat(ai): synthesize + refine endpoints"
```

---

### Task 7: Preview endpoint

**Files:** Modify `apps/api/src/routes/import-parsers.ts`; extend `apps/api/src/routes/import-parsers-ai.test.ts`.

- [ ] **Step 1: Add the failing test**

Append to `apps/api/src/routes/import-parsers-ai.test.ts`:

```typescript
test("preview parses the sample with a config and returns first rows + counts", async () => {
  const { cookie } = await initAndLogin({ app });
  const res = await app.handle(new Request("http://localhost/import-parsers/preview", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ content: "Date,Desc,Amount\n2026-01-01,COFFEE,-4.50\n2026-01-02,PAY,1000.00", config: CONFIG, currency: "USD" }),
  }));
  expect(res.status).toBe(200);
  const out = await res.json();
  expect(out.total).toBe(2);
  expect(out.errorCount).toBe(0);
  expect(out.rows[0]).toMatchObject({ date: "2026-01-01", amountMinor: -450, description: "COFFEE" });
});

test("preview returns 422 on an invalid config", async () => {
  const { cookie } = await initAndLogin({ app });
  const res = await app.handle(new Request("http://localhost/import-parsers/preview", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ content: "x", config: { version: 1, format: "csv" }, currency: "USD" }),
  }));
  expect(res.status).toBe(422);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun test src/routes/import-parsers-ai.test.ts`
Expected: FAIL — preview route 404.

- [ ] **Step 3: Implement**

In `apps/api/src/routes/import-parsers.ts`, add imports (if not already present):

```typescript
import { parseCsv } from "../lib/import/csv";
import { validateParserConfig } from "../lib/import/validate";
```

(`validateParserConfig` is already imported in this file from earlier tasks — reuse it.) Chain:

```typescript
  .post(
    "/import-parsers/preview",
    async ({ body, set }: any) => {
      let config;
      try { config = validateParserConfig(body.config); }
      catch { set.status = 422; return { error: "invalid_config" }; }
      const rows = parseCsv(body.content, config, (body.currency ?? "USD").toUpperCase());
      const errorCount = rows.filter((r) => r.error || r.date === null || r.amountMinor === null).length;
      return { rows: rows.slice(0, 5), total: rows.length, errorCount };
    },
    { body: t.Object({ content: t.String(), config: t.Unknown(), currency: t.Optional(t.String()) }) },
  )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && bun test src/routes/import-parsers-ai.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Full API sweep + typecheck**

Run: `cd apps/api && bun test` → all pass.
Run: `cd apps/web && bun run build` → clean (new routes flow into Eden `App`).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/import-parsers.ts apps/api/src/routes/import-parsers-ai.test.ts
git commit -m "feat(ai): live-preview endpoint (real parseCsv, first rows + counts)"
```

---

### Task 8: Settings UI — "Smart import (AI)" section

**Files:** Modify `apps/web/src/routes/settings.tsx`.

- [ ] **Step 1: Implement the section**

Open `apps/web/src/routes/settings.tsx`, read how an existing settings section + save works (the file already PATCHes `/settings`). Add a card/section "Smart import (AI)" with three controlled inputs and a Test button. Use the existing `api` client and the page's existing save pattern. Concretely add this block within the settings page body (adapt class names / save handler to the file's conventions):

```tsx
{/* Smart import (AI) — single OpenAI-compatible provider. */}
<section className="space-y-3">
  <div>
    <h2 className="text-base font-medium">Smart import (AI)</h2>
    <p className="text-sm text-muted-foreground">
      Optional. Point at a local model (e.g. Ollama <code>http://localhost:11434/v1</code>) or a
      cloud endpoint. A cloud URL sends sample statement text to that provider; a local URL keeps
      it on this machine.
    </p>
  </div>
  <div className="grid gap-3 sm:max-w-lg">
    <div className="space-y-1">
      <Label>Base URL</Label>
      <Input value={aiBaseUrl} onChange={(e) => setAiBaseUrl(e.target.value)} placeholder="http://localhost:11434/v1" data-testid="ai-base-url" />
    </div>
    <div className="space-y-1">
      <Label>Model</Label>
      <Input value={aiModel} onChange={(e) => setAiModel(e.target.value)} placeholder="llama3.1" data-testid="ai-model" />
    </div>
    <div className="space-y-1">
      <Label>API key {aiApiKeySet && <span className="text-muted-foreground">(set — leave blank to keep)</span>}</Label>
      <Input type="password" value={aiApiKey} onChange={(e) => setAiApiKey(e.target.value)} placeholder={aiApiKeySet ? "••••••••" : "optional"} data-testid="ai-api-key" />
    </div>
    <div className="flex items-center gap-2">
      <Button onClick={saveAi} data-testid="ai-save">Save</Button>
      <Button variant="outline" onClick={testAi} data-testid="ai-test">Test connection</Button>
      {aiTestMsg && <span className="text-sm text-muted-foreground">{aiTestMsg}</span>}
    </div>
  </div>
</section>
```

Add the state + handlers near the component's other hooks (seed from `GET /settings`):

```tsx
const [aiBaseUrl, setAiBaseUrl] = useState("");
const [aiModel, setAiModel] = useState("");
const [aiApiKey, setAiApiKey] = useState("");
const [aiApiKeySet, setAiApiKeySet] = useState(false);
const [aiTestMsg, setAiTestMsg] = useState("");

// In the same effect/query that loads settings, set: setAiBaseUrl(s.aiBaseUrl), setAiModel(s.aiModel), setAiApiKeySet(s.aiApiKeySet)

async function saveAi() {
  const payload: { aiBaseUrl: string; aiModel: string; aiApiKey?: string } = { aiBaseUrl, aiModel };
  if (aiApiKey) payload.aiApiKey = aiApiKey;
  const { error } = await api.settings.patch(payload);
  if (error) { setAiTestMsg("Save failed"); return; }
  setAiApiKey(""); setAiApiKeySet(aiApiKeySet || !!aiApiKey); setAiTestMsg("Saved");
}
async function testAi() {
  setAiTestMsg("Testing…");
  const { data } = await api.settings.ai.test.post();
  setAiTestMsg(data?.ok ? "Connection ok" : `Failed: ${data?.message ?? "error"}`);
}
```

Ensure `useState`, `Input`, `Label`, `Button`, and `api` are imported (most already are in this file).

- [ ] **Step 2: Build**

Run: `cd apps/web && bun run build`
Expected: success. Fix any Eden accessor mismatch (e.g. `api.settings.ai.test.post` vs `api.settings["ai/test"]`) to match the generated `App` type — no `as any`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/settings.tsx
git commit -m "feat(ai): Settings 'Smart import (AI)' section with test connection"
```

---

### Task 9: Import dialog — drop zone, Generate with AI, live preview, Refine

**Files:** Modify `apps/web/src/components/import-dialog.tsx`.

This builds on the existing dialog (file input, parser select, manual mapping form, Parse & review). Read the current file first; keep all existing behavior and add to the "create new parser" path.

- [ ] **Step 1: Replace the bare file input with a drop zone**

Find the `Input type="file"` block and replace with a drag-and-drop target that reuses the existing `onFile` logic (extract the file-reading into a `handleFile(file: File)` and call it from both drop and click):

```tsx
<div
  data-testid="import-dropzone"
  onDragOver={(e) => { e.preventDefault(); }}
  onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) void handleFile(f); }}
  onClick={() => fileInputRef.current?.click()}
  className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-input py-8 text-center text-sm text-muted-foreground hover:border-ring"
>
  <span className="text-base">⬆ Drop your statement here</span>
  <span>or click to browse (.csv){filename ? ` — ${filename}` : ""}</span>
  <input ref={fileInputRef} type="file" accept=".csv,text/csv" className="hidden"
    data-testid="import-file" onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); }} />
</div>
```

Add `const fileInputRef = useRef<HTMLInputElement>(null);` and `import { useRef } from "react";`. Rename the existing `onFile` to `handleFile(file: File)` taking the file directly (it already reads text, sets filename/content, runs detect).

- [ ] **Step 2: Add "Generate with AI" + AI-enabled detection**

On mount (or in the settings load), fetch `GET /settings` once to learn if AI is enabled:

```tsx
const [aiEnabled, setAiEnabled] = useState(false);
useEffect(() => { api.settings.get().then(({ data }) => {
  if (data && "aiBaseUrl" in data) setAiEnabled(!!data.aiBaseUrl && !!data.aiModel);
}); }, []);
```

In the `needsMapping` (Create-new) block, above the form fields, add:

```tsx
{aiEnabled && (
  <Button type="button" variant="outline" disabled={!content || aiBusy} data-testid="ai-generate"
    onClick={async () => {
      setAiBusy(true);
      try {
        const { data, error } = await api["import-parsers"].synthesize.post({ content });
        if (error || !data || !("config" in data)) { setAiMsg("AI couldn't generate — map manually"); return; }
        applyConfig(data.config);
        setAiMsg("");
      } finally { setAiBusy(false); }
    }}>
    {aiBusy ? "Generating…" : "✨ Generate with AI"}
  </Button>
)}
{aiMsg && <p className="text-sm text-muted-foreground">{aiMsg}</p>}
```

Add `const [aiBusy, setAiBusy] = useState(false); const [aiMsg, setAiMsg] = useState("");`. Write `applyConfig(cfg)` to set the form state from a `CsvParserConfig` (date column/format, description column, amount column/sign):

```tsx
function applyConfig(cfg: { fields: { date: { column: string; format: string }; description: { column: string }; amount: { mode: string; column?: string; sign?: string } } }) {
  setDateCol(cfg.fields.date.column); setDateFmt(cfg.fields.date.format);
  setDescCol(cfg.fields.description.column);
  if (cfg.fields.amount.mode === "single") {
    setAmountCol(cfg.fields.amount.column ?? "");
    setSign(cfg.fields.amount.sign === "positiveIsDebit" ? "positiveIsDebit" : "negativeIsDebit");
  }
}
```

- [ ] **Step 3: Add the live preview (debounced) and Refine**

Add preview state and a debounced effect that calls `/preview` whenever the mapping changes and a file is loaded:

```tsx
const [preview, setPreview] = useState<{ rows: Array<{ date: string | null; amountMinor: number | null; description: string }>; total: number; errorCount: number } | null>(null);
useEffect(() => {
  if (!content || !needsMapping || !dateCol || !descCol || !amountCol) { setPreview(null); return; }
  const cfg = buildConfig();
  const t = setTimeout(async () => {
    const { data } = await api["import-parsers"].preview.post({ content, config: cfg, currency: accountCurrency });
    if (data && "rows" in data) setPreview(data);
  }, 400);
  return () => clearTimeout(t);
}, [content, needsMapping, dateCol, dateFmt, descCol, amountCol, sign, accountCurrency]);
```

Render the preview + refine UI below the form (inside `needsMapping`):

```tsx
{preview && (
  <div className="space-y-1 rounded-md border p-2 text-sm">
    <div className="flex justify-between text-muted-foreground">
      <span>Preview</span><span>{preview.total - preview.errorCount} ok · {preview.errorCount} errors</span>
    </div>
    {preview.rows.map((r, i) => (
      <div key={i} className="flex justify-between tabular-nums">
        <span>{r.date ?? "—"}</span><span className="flex-1 truncate px-2">{r.description}</span>
        <span>{r.amountMinor === null ? "—" : (r.amountMinor / 100).toFixed(2)}</span>
      </div>
    ))}
  </div>
)}
{aiEnabled && needsMapping && (
  <div className="flex items-center gap-2">
    <Input value={refineText} onChange={(e) => setRefineText(e.target.value)} placeholder="Tell the AI what's off…" data-testid="ai-refine-input" />
    <Button type="button" variant="outline" disabled={aiBusy || !content} data-testid="ai-refine"
      onClick={() => void runRefine(refineText)}>Refine</Button>
    {preview && preview.errorCount > 0 && (
      <Button type="button" variant="ghost" disabled={aiBusy} data-testid="ai-fix-errors"
        onClick={() => void runRefine("Fix the rows that failed to parse.")}>Ask AI to fix these</Button>
    )}
  </div>
)}
```

Add state + `runRefine`:

```tsx
const [refineText, setRefineText] = useState("");
async function runRefine(instruction: string) {
  setAiBusy(true);
  try {
    const { data, error } = await api["import-parsers"].refine.post({ content, config: buildConfig(), instruction, errors: [] });
    if (error || !data || !("config" in data)) { setAiMsg("Refine failed"); return; }
    applyConfig(data.config); setRefineText(""); setAiMsg("");
  } finally { setAiBusy(false); }
}
```

(The preview's error rows aren't threaded into `errors` for v1 — the model still gets the current config + instruction; "Ask AI to fix these" passes the implicit instruction. Threading raw error rows is a fast follow.)

- [ ] **Step 4: Build**

Run: `cd apps/web && bun run build`
Expected: success. Resolve any Eden accessor naming (`api["import-parsers"].synthesize.post` etc.) to match the generated `App`. No `as any`; narrow responses with `"config" in data` / `"rows" in data`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/import-dialog.tsx
git commit -m "feat(ai): import dialog — drop zone, Generate with AI, live preview, Refine"
```

---

### Task 10: e2e — deterministic drop → map → preview → review

**Files:** Create `e2e/tests/import-ai.spec.ts`.

This exercises the new **drop zone + live preview** on the deterministic path (no AI provider needed — the AI buttons are hidden when unconfigured, which is the default test state).

- [ ] **Step 1: Write the test**

```typescript
import { test, expect } from "./fixtures";
import { seedHousehold, createAccount } from "./helpers";

const CSV = "Date,Description,Amount\n2026-02-01,COFFEE BEAN,-4.50\n2026-02-02,SALARY,2500.00\n";

test.beforeEach(async ({ backend, request, context }) => {
  await backend.freshDb();
  await seedHousehold(request, context, backend.apiURL);
});

test("drop a CSV, map columns, see live preview, import", async ({ page }) => {
  await page.goto("/");
  await createAccount(page, { name: "Checking", currency: "USD" });
  await page.reload();
  await page.getByTestId("account-row").filter({ hasText: "Checking" }).click();
  await expect(page).toHaveURL(/\/accounts\//);

  await page.getByRole("button", { name: "Import statement" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByTestId("import-file").setInputFiles({ name: "feb.csv", mimeType: "text/csv", buffer: Buffer.from(CSV) });

  // Create-new mapping
  await dialog.getByTestId("map-date").click();
  await page.getByRole("option", { name: "Date" }).click();
  await dialog.getByTestId("map-dateformat").fill("YYYY-MM-DD");
  await dialog.getByTestId("map-desc").click();
  await page.getByRole("option", { name: "Description" }).click();
  await dialog.getByTestId("map-amount").click();
  await page.getByRole("option", { name: "Amount" }).click();

  // Live preview appears (debounced)
  await expect(dialog.getByText(/2 ok · 0 errors/)).toBeVisible();

  await dialog.getByTestId("import-run").click();
  await expect(dialog.getByTestId("import-row")).toHaveCount(2);
  await dialog.getByTestId("import-commit").click();
  await expect(dialog).toBeHidden();
});
```

- [ ] **Step 2: Run**

Run: `for p in 5300 3100; do lsof -ti tcp:$p | xargs kill 2>/dev/null; done; cd e2e && bunx playwright test import-ai.spec.ts --retries=0 --reporter=line`
Expected: 1 passed. If preview text/selectors differ from the rendered markup, adjust to match Task 9's output.

- [ ] **Step 3: Full sweep**

Run: `cd apps/api && bun test` → all pass.
Run: `cd apps/web && bun run build` → clean.
Run: `cd e2e && bunx playwright test --retries=0 --reporter=line` → all pass.

- [ ] **Step 4: Commit**

```bash
git add e2e/tests/import-ai.spec.ts
git commit -m "test(ai): e2e drop+map+live-preview+import happy path"
```

---

## Self-Review

**Spec coverage** (vs `2026-06-15-ai-parser-synthesis-design.md`, Spec 3):
- Settings AI config (B; columns; `aiApiKeySet`; key write-only; test connection): Tasks 1, 4, 5, 8. ✓
- Single OpenAI-compatible adapter (`{baseUrl,model,apiKey?}`): Tasks 2, 3. ✓
- Synthesize / refine / preview endpoints + error taxonomy (422 not_configured / 422 invalid_output / 502 unavailable): Tasks 6, 7. ✓
- Output untrusted → `validateParserConfig`: Tasks 2 (adapter), 7 (preview). ✓
- Dialog: drop zone, Generate with AI, live preview, Refine + "fix these": Task 9. ✓
- Privacy (key never returned; cloud-sends-sample note; sample cap): Task 4 (key), 8 (note); sample cap is in the adapter prompt (Task 2 sends headers+rows the caller provides — the dialog already slices the file; note: cap enforced by sending only the uploaded CSV content, which for v1 is the whole small file — a hard byte cap is a fast follow, recorded below).
- Testing (mocked transport, route fixtures, key-not-leaked, e2e): Tasks 3, 4, 6, 7, 10. ✓
- North-star items (PDF/OCR/vision/brokerage): correctly **out of scope**, their own specs.

**Known fast-follows (not blockers, recorded so they aren't mistaken for "done"):** (a) hard byte-cap on the sample sent to the model (design says ≤8 KB / ~20 rows — currently the whole CSV `content` is sent; add a slice in `synthesize`/`refine` route or adapter); (b) thread the live-preview error rows into `refine`'s `errors` argument (the endpoint already accepts them; the dialog passes `[]` in v1).

**Placeholder scan:** none — every code/test/command step is concrete. The "fast-follows" are explicitly deferred scope, not placeholders in the build.

**Type consistency:** `AiConfig`/`AiError`/`chatJson`/`synthesizeCsvConfig`/`refineCsvConfig` defined in Task 2 are used unchanged in Tasks 3, 5, 6. `loadAiConfig`/`aiErrorResponse` defined in Task 6 used in Task 7's file. `applyConfig`/`buildConfig`/`handleFile` consistent within Task 9. Settings fields `aiBaseUrl`/`aiModel`/`aiApiKey`/`aiApiKeySet` consistent across Tasks 1, 4, 5, 8, 9. `parseCsv(content, config, currency)` 3-arg signature (Spec 1) used in Task 7.
