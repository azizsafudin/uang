# Add-instrument (Symbol / ISIN / Manual) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users add an instrument by Symbol or ISIN (with a read-only provider preview) or Manually, from both a new "Add instrument" dialog on `/instruments` and the Add-transaction dialog — so identifiers land in the correct field and "Update prices" works.

**Architecture:** A new `POST /market-data/lookup` endpoint runs a Yahoo search → chart and returns a normalized preview (resolved symbol, name, currency, kind, price). A shared `<NewInstrumentForm>` React component owns the 3 modes and publishes a validated `NewInstrumentSpec` to its parent; parents create the instrument on their own submit and then backfill prices via the existing refresh endpoint. No resolver change, no data migration.

**Tech Stack:** Elysia + Drizzle (libsql/SQLite); React + TanStack Router/Query/DB; Eden treaty; Bun test runner.

---

### Task 1: Backend lookup endpoint

**Files:**
- Modify: `apps/api/src/lib/market-data/types.ts` (add `InstrumentLookupResult`)
- Modify: `apps/api/src/lib/market-data/providers/yahoo.ts` (add `yahooLookup` + `kindFromQuoteType`)
- Modify: `apps/api/src/lib/market-data/index.ts` (export `lookupInstrument`)
- Modify: `apps/api/src/routes/market-data.ts` (add `POST /lookup`)
- Test: `apps/api/src/lib/market-data/providers/yahoo.test.ts`, `apps/api/src/routes/market-data.test.ts`

- [ ] **Step 1: Write the failing provider tests**

In `apps/api/src/lib/market-data/providers/yahoo.test.ts`, add `yahooLookup` to the import on line 3:

```ts
import { makeYahooPriceProvider, makeYahooFxProvider, yahooLookup } from "./yahoo";
```

Append these tests (they reuse the file's existing `mock(handler)` helper):

```ts
test("yahooLookup resolves a query to name, kind, currency, symbol and price", async () => {
  const server = mock((url) => {
    if (url.pathname.endsWith("/search")) {
      return { quotes: [
        { symbol: "0P0001OO2F.SI", score: 20001, isYahooFinance: true, quoteType: "MUTUALFUND", longname: "Amundi Core MSCI EM Fund" },
        { symbol: "LU2420246139-SGD.LU", score: 20000, isYahooFinance: true, quoteType: "MUTUALFUND", longname: "x" },
      ] };
    }
    expect(decodeURIComponent(url.pathname)).toContain("0P0001OO2F.SI");
    return { chart: { result: [{ meta: { regularMarketPrice: 223.25, currency: "SGD", regularMarketTime: 1_750_000_000 } }] } };
  });
  try {
    const r = await yahooLookup("LU2420246139");
    expect(r?.name).toBe("Amundi Core MSCI EM Fund");
    expect(r?.kind).toBe("fund");
    expect(r?.currency).toBe("SGD");
    expect(r?.resolvedSymbol).toBe("0P0001OO2F.SI");
    expect(r?.price).toBe(223.25);
    expect(r?.source).toBe("yahoo");
  } finally { server.stop(true); }
});

test("yahooLookup returns null when search has no match", async () => {
  const server = mock((url) => {
    if (url.pathname.endsWith("/search")) return { quotes: [] };
    return { chart: { result: [] } };
  });
  try {
    expect(await yahooLookup("NOPE")).toBeNull();
  } finally { server.stop(true); }
});

test("yahooLookup returns null when the resolved symbol has no price", async () => {
  const server = mock((url) => {
    if (url.pathname.endsWith("/search")) return { quotes: [{ symbol: "X.Y", score: 1, isYahooFinance: true, quoteType: "EQUITY", shortname: "X" }] };
    return { chart: { result: [{ meta: { currency: "USD" } }] } }; // no regularMarketPrice
  });
  try {
    expect(await yahooLookup("X")).toBeNull();
  } finally { server.stop(true); }
});
```

- [ ] **Step 2: Run the provider tests to verify they fail**

Run: `cd apps/api && bun test src/lib/market-data/providers/yahoo.test.ts -t "yahooLookup"`
Expected: FAIL — `yahooLookup` is not exported (import/type error or "not a function").

- [ ] **Step 3: Add the `InstrumentLookupResult` type**

In `apps/api/src/lib/market-data/types.ts`, append:

```ts
export interface InstrumentLookupResult {
  resolvedSymbol: string;
  name: string;
  currency: string;
  kind: "stock" | "etf" | "fund" | "crypto" | "other";
  price: number;
  date: string;  // YYYY-MM-DD
  source: string;
}
```

- [ ] **Step 4: Implement `yahooLookup` in the Yahoo provider**

In `apps/api/src/lib/market-data/providers/yahoo.ts`, extend the type import on line 2 to include `InstrumentLookupResult`:

```ts
import type { InstrumentPriceProvider, FxRateProvider, InstrumentRef, PriceResult, FxResult, InstrumentLookupResult } from "../types";
```

Append at the end of the file (reuses the module-level `HEADERS`, `endpoints`, `chartFetch`, `isoFromEpoch`):

```ts
function kindFromQuoteType(t: string | undefined): InstrumentLookupResult["kind"] {
  switch (t) {
    case "EQUITY": return "stock";
    case "ETF": return "etf";
    case "MUTUALFUND": return "fund";
    case "CRYPTOCURRENCY": return "crypto";
    default: return "other";
  }
}

// Resolve a free-form query (ticker or ISIN) to a preview: best Yahoo match's
// name/type, plus its latest price/currency from the chart endpoint. Returns null
// unless we get BOTH a name and a price (so a preview always shows a price and the
// later "Update prices" can reproduce it).
export async function yahooLookup(query: string, fetchImpl: typeof fetch = fetch): Promise<InstrumentLookupResult | null> {
  const q = query.trim();
  if (!q) return null;
  const res = await fetchImpl(`${endpoints.yahooSearch}?q=${encodeURIComponent(q)}&quotesCount=6&newsCount=0`, { headers: HEADERS });
  if (!res.ok) return null;
  const body = await res.json() as {
    quotes?: Array<{ symbol?: string; score?: number; isYahooFinance?: boolean; quoteType?: string; shortname?: string; longname?: string }>;
  };
  const best = (body.quotes ?? [])
    .filter((x) => x.isYahooFinance && typeof x.symbol === "string")
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
  if (!best?.symbol) return null;
  const name = best.longname ?? best.shortname;
  if (!name) return null;
  const r = await chartFetch(fetchImpl, best.symbol, "range=5d&interval=1d");
  const meta = r?.meta;
  if (!meta || typeof meta.regularMarketPrice !== "number") return null;
  return {
    resolvedSymbol: best.symbol,
    name,
    currency: meta.currency ?? "USD",
    kind: kindFromQuoteType(best.quoteType),
    price: meta.regularMarketPrice,
    date: isoFromEpoch(meta.regularMarketTime),
    source: "yahoo",
  };
}
```

- [ ] **Step 5: Run the provider tests to verify they pass**

Run: `cd apps/api && bun test src/lib/market-data/providers/yahoo.test.ts -t "yahooLookup"`
Expected: PASS (all three).

- [ ] **Step 6: Write the failing route test**

In `apps/api/src/routes/market-data.test.ts`, append (the file already imports `endpoints` and restores it in `afterEach`, and builds `app` via `makeApp(marketDataRoutes, settingsRoutes)`):

```ts
test("POST /market-data/lookup returns a preview for a resolvable query", async () => {
  const { cookie } = await initAndLogin({ app });
  const server = Bun.serve({ port: 0, fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/search")) {
      return Response.json({ quotes: [{ symbol: "AAPL", score: 1, isYahooFinance: true, quoteType: "EQUITY", shortname: "Apple Inc." }] });
    }
    return Response.json({ chart: { result: [{ meta: { regularMarketPrice: 200, currency: "USD", regularMarketTime: 1_750_000_000 } }] } });
  }});
  endpoints.yahooChart = `http://localhost:${server.port}/chart`;
  endpoints.yahooSearch = `http://localhost:${server.port}/search`;
  try {
    const res = await app.handle(new Request("http://localhost/market-data/lookup", {
      method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ query: "AAPL" }),
    }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.found).toBe(true);
    expect(json.name).toBe("Apple Inc.");
    expect(json.kind).toBe("stock");
    expect(json.resolvedSymbol).toBe("AAPL");
    expect(json.price).toBe(200);
  } finally { server.stop(true); }
});

test("POST /market-data/lookup reports not found", async () => {
  const { cookie } = await initAndLogin({ app });
  const server = Bun.serve({ port: 0, fetch() { return Response.json({ quotes: [] }); } });
  endpoints.yahooChart = `http://localhost:${server.port}/chart`;
  endpoints.yahooSearch = `http://localhost:${server.port}/search`;
  try {
    const res = await app.handle(new Request("http://localhost/market-data/lookup", {
      method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ query: "NOPE" }),
    }));
    expect((await res.json()).found).toBe(false);
  } finally { server.stop(true); }
});
```

- [ ] **Step 7: Run the route test to verify it fails**

Run: `cd apps/api && bun test src/routes/market-data.test.ts -t "lookup"`
Expected: FAIL — `/market-data/lookup` returns 404.

- [ ] **Step 8: Add `lookupInstrument` and the route**

In `apps/api/src/lib/market-data/index.ts`:
- Add `yahooLookup` to the yahoo import (line 7): `import { makeYahooPriceProvider, makeYahooFxProvider, yahooLookup } from "./providers/yahoo";`
- Add `InstrumentLookupResult` to the types import (line 11): `import type { InstrumentPriceProvider, FxRateProvider, InstrumentRef, InstrumentLookupResult } from "./types";`
- Append:

```ts
export async function lookupInstrument(query: string): Promise<InstrumentLookupResult | null> {
  return yahooLookup(query);
}
```

In `apps/api/src/routes/market-data.ts`:
- Add `lookupInstrument` to the import on line 6: `import { refreshInstrumentPrice, refreshAllPrices, refreshFx, lookupInstrument } from "../lib/market-data";`
- Add the route to the chain (e.g. right after the `/fx/refresh` route, before `/test`):

```ts
  .post("/lookup", async ({ body }: any) => {
    const r = await lookupInstrument(body.query);
    return r ? { found: true, ...r } : { found: false };
  }, { body: t.Object({ query: t.String({ minLength: 1 }) }) })
```

- [ ] **Step 9: Run the route test, then the full market-data + web build**

Run: `cd apps/api && bun test src/routes/market-data.test.ts -t "lookup"`
Expected: PASS.
Run: `cd apps/api && bun test src/lib/market-data src/routes/market-data.test.ts`
Expected: PASS (no regressions).
Run: `cd apps/web && bun run build`
Expected: build succeeds; Eden now exposes `api["market-data"].lookup.post`.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/lib/market-data apps/api/src/routes/market-data.ts
git commit -m "feat(api): POST /market-data/lookup resolves symbol/ISIN to a preview"
```

---

### Task 2: Shared `NewInstrumentForm` component

**Files:**
- Create: `apps/web/src/components/new-instrument-form.tsx`

- [ ] **Step 1: Create the component**

Create `apps/web/src/components/new-instrument-form.tsx`:

```tsx
import { useState } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { instrumentKindLabel } from "@/components/labels";

export type Kind = "stock" | "etf" | "fund" | "crypto" | "other";
export type NewInstrumentSpec = {
  name: string;
  kind: Kind;
  currency: string;
  symbol: string | null;
  isin: string | null;
};

type Mode = "symbol" | "isin" | "manual";
const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
const KINDS: Kind[] = ["stock", "etf", "fund", "crypto", "other"];

type Preview = { name: string; kind: Kind; currency: string; price: number; date: string; resolvedSymbol: string };

export function NewInstrumentForm({
  defaultCurrency,
  onResolved,
}: {
  defaultCurrency: string;
  onResolved: (spec: NewInstrumentSpec | null) => void;
}) {
  const [mode, setMode] = useState<Mode>("symbol");
  const [query, setQuery] = useState("");
  const [finding, setFinding] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mName, setMName] = useState("");
  const [mCurrency, setMCurrency] = useState(defaultCurrency);
  const [mKind, setMKind] = useState<Kind>("stock");

  function clearPreview() {
    setPreview(null);
    setError("");
    onResolved(null);
  }

  function switchMode(next: Mode) {
    setMode(next);
    setQuery("");
    clearPreview();
    if (next === "manual") publishManual(mName, mCurrency, mKind);
  }

  function publishManual(name: string, currency: string, kind: Kind) {
    const ok = name.trim().length > 0 && /^[A-Za-z]{3}$/.test(currency.trim());
    onResolved(ok ? { name: name.trim(), kind, currency: currency.trim().toUpperCase(), symbol: null, isin: null } : null);
  }

  async function find() {
    clearPreview();
    const q = query.trim().toUpperCase();
    if (!q) return;
    if (mode === "isin" && !ISIN_RE.test(q)) {
      setError("That doesn't look like a valid ISIN (e.g. LU2420246139).");
      return;
    }
    setFinding(true);
    const { data, error: err } = await api["market-data"].lookup.post({ query: q });
    setFinding(false);
    if (err || !data || !("found" in data) || !data.found) {
      setError("No match found. Try Manual entry to add it with a price you set yourself.");
      return;
    }
    const p: Preview = {
      name: data.name, kind: data.kind as Kind, currency: data.currency,
      price: data.price, date: data.date, resolvedSymbol: data.resolvedSymbol,
    };
    setPreview(p);
    onResolved({
      name: p.name, kind: p.kind, currency: p.currency,
      symbol: mode === "symbol" ? p.resolvedSymbol : null,
      isin: mode === "isin" ? q : null,
    });
  }

  if (mode === "manual") {
    return (
      <div className="space-y-4 rounded-lg border border-border p-3">
        <Field label="Name">
          <Input
            data-testid="ni-manual-name"
            value={mName}
            onChange={(e) => { setMName(e.target.value); publishManual(e.target.value, mCurrency, mKind); }}
          />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Currency">
            <Input
              data-testid="ni-manual-currency"
              maxLength={3}
              value={mCurrency}
              onChange={(e) => { setMCurrency(e.target.value); publishManual(mName, e.target.value, mKind); }}
            />
          </Field>
          <Field label="Kind">
            <Select value={mKind} onValueChange={(v: string | null) => { if (v) { setMKind(v as Kind); publishManual(mName, mCurrency, v as Kind); } }}>
              <SelectTrigger className="w-full"><SelectValue>{(v: unknown) => instrumentKindLabel(String(v))}</SelectValue></SelectTrigger>
              <SelectContent>
                {KINDS.map((k) => (<SelectItem key={k} value={k}>{instrumentKindLabel(k)}</SelectItem>))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => switchMode("symbol")}>
          ← Look up by symbol/ISIN instead
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="inline-flex rounded-md border border-border p-0.5 text-sm">
        {(["symbol", "isin"] as const).map((m) => (
          <button
            key={m}
            type="button"
            data-testid={`ni-mode-${m}`}
            onClick={() => switchMode(m)}
            className={cn("rounded px-3 py-1", mode === m ? "bg-muted font-medium" : "text-muted-foreground")}
          >
            {m === "symbol" ? "Symbol" : "ISIN"}
          </button>
        ))}
      </div>

      <div className="flex items-end gap-2">
        <Field label={mode === "symbol" ? "Ticker symbol" : "ISIN"} className="flex-1">
          <Input
            data-testid="ni-query"
            value={query}
            placeholder={mode === "symbol" ? "AAPL, D05" : "LU2420246139"}
            onChange={(e) => { setQuery(e.target.value); clearPreview(); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); find(); } }}
          />
        </Field>
        <Button type="button" variant="outline" data-testid="ni-find" disabled={finding || !query.trim()} onClick={find}>
          {finding ? "Finding…" : "Find"}
        </Button>
      </div>

      {error && <p className="text-sm text-destructive" data-testid="ni-error">{error}</p>}

      {preview && (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm" data-testid="ni-preview">
          <p className="font-medium">
            {preview.resolvedSymbol} · {preview.name}
            <span className="ml-2 rounded-full bg-muted px-1.5 py-0.5 text-[0.65rem] font-medium text-muted-foreground">
              {instrumentKindLabel(preview.kind)}
            </span>
          </p>
          <p className="text-muted-foreground tabular-nums">
            {preview.price} {preview.currency} · as of {preview.date}
          </p>
        </div>
      )}

      <Button type="button" variant="ghost" size="sm" onClick={() => switchMode("manual")}>
        Can't find it? Add manually
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && bun run build`
Expected: build succeeds. Confirms `api["market-data"].lookup.post` is typed and `instrumentKindLabel`/`Field`/`Select` imports resolve. (If `instrumentKindLabel` does not accept the literal kind strings, pass `String(k)`.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/new-instrument-form.tsx
git commit -m "feat(web): shared NewInstrumentForm (Symbol/ISIN lookup + Manual)"
```

---

### Task 3: "Add instrument" dialog on `/instruments`

**Files:**
- Create: `apps/web/src/components/add-instrument-dialog.tsx`
- Modify: `apps/web/src/routes/instruments.tsx` (render the dialog beside "Update prices")

- [ ] **Step 1: Create the dialog**

Create `apps/web/src/components/add-instrument-dialog.tsx`:

```tsx
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { instrumentsCollection } from "@/lib/collections";
import { Button } from "@/components/ui/button";
import { NewInstrumentForm, type NewInstrumentSpec } from "@/components/new-instrument-form";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger,
} from "@/components/ui/responsive-dialog";

export function AddInstrumentDialog({ defaultCurrency }: { defaultCurrency: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [spec, setSpec] = useState<NewInstrumentSpec | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function add() {
    if (!spec) return;
    setBusy(true); setErr("");
    const { data, error } = await api.instruments.post({
      name: spec.name, kind: spec.kind, currency: spec.currency,
      symbol: spec.symbol ?? undefined, isin: spec.isin ?? undefined,
    });
    if (error || !data || !("id" in data) || !data.id) {
      setBusy(false);
      setErr(String(error) === "[object Object]" ? "Couldn't add instrument." : "An instrument with this symbol already exists.");
      return;
    }
    // Looked-up instruments: pull an initial provider price so they don't show "—".
    if (spec.symbol || spec.isin) {
      await api["market-data"].instrument({ id: data.id }).refresh.post({ backfill: true });
    }
    await instrumentsCollection.utils.refetch();
    await qc.invalidateQueries({ queryKey: ["instruments"] });
    await qc.invalidateQueries({ queryKey: ["networth"] });
    setBusy(false);
    setOpen(false);
    setSpec(null);
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setSpec(null); setErr(""); } }}>
      <ResponsiveDialogTrigger render={<Button variant="outline" size="sm" data-testid="add-instrument" />}>
        Add instrument
      </ResponsiveDialogTrigger>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Add instrument</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="space-y-3">
          <NewInstrumentForm defaultCurrency={defaultCurrency} onResolved={setSpec} />
          {err && <p className="text-sm text-destructive">{err}</p>}
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button type="button" data-testid="add-instrument-submit" disabled={!spec || busy} onClick={add}>
            {busy ? "Adding…" : "Add instrument"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
```

- [ ] **Step 2: Render it on the instruments page**

In `apps/web/src/routes/instruments.tsx`, add the import:

```ts
import { AddInstrumentDialog } from "@/components/add-instrument-dialog";
```

Inside the action row (the `<div className="mt-2 mb-5 flex flex-wrap items-center gap-2">` at line 55), add the dialog after the "Update prices" `<Button>` (after line 58):

```tsx
        <AddInstrumentDialog defaultCurrency="USD" />
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/web && bun run build`
Expected: build succeeds.

- [ ] **Step 4: Manual smoke check**

With the app running, on `/instruments` click **Add instrument** → ISIN mode → enter `LU2420246139` → **Find**. Expected: a preview card shows the fund name, SGD, fund, and a price; **Add instrument** creates it and it appears in the list with a price (not "—"). Repeat with Symbol mode + `AAPL`, and Manual mode (name/currency/kind, no price until you add one).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/add-instrument-dialog.tsx apps/web/src/routes/instruments.tsx
git commit -m "feat(web): Add instrument dialog on /instruments"
```

---

### Task 4: Use `NewInstrumentForm` in the Add-transaction dialog

**Files:**
- Modify: `apps/web/src/components/add-transaction-dialog.tsx`

The current "New instrument…" branch uses inline `newInstr.*` fields and creates the instrument inside `onSubmit`. Replace it with `NewInstrumentForm` + a `newSpec` state; create on submit, then backfill.

- [ ] **Step 1: Add the import and spec state**

Add the import near the other component imports:

```ts
import { NewInstrumentForm, type NewInstrumentSpec } from "@/components/new-instrument-form";
```

Inside `AddTransactionDialog`, after the `const [splitApplied, setSplitApplied] = useState(false);` line (line 50), add:

```ts
  const [newSpec, setNewSpec] = useState<NewInstrumentSpec | null>(null);
```

- [ ] **Step 2: Reset the spec with the form**

In `resetForm()` (lines 76-79), add `setNewSpec(null);`:

```ts
  function resetForm() {
    reset(defaults());
    setSplitApplied(false);
    setNewSpec(null);
  }
```

- [ ] **Step 3: Derive the new-instrument currency from the spec**

Replace the `securityCurrency` definition (lines 122-123) so it uses the resolved spec instead of the removed `newInstr.currency` watch:

```ts
  const securityCurrency =
    instrumentId === NEW_INSTRUMENT ? (newSpec?.currency ?? accountCurrency) : selected?.currency ?? accountCurrency;
```

Delete the now-unused `const newInstrCurrency = watch("newInstr.currency");` line (line 89).

- [ ] **Step 4: Replace the inline new-instrument fields with the component**

Replace the entire block `{instrumentId === NEW_INSTRUMENT && ( … )}` (lines 253-283, the bordered grid with Name/Symbol/Currency/Kind) with:

```tsx
            {instrumentId === NEW_INSTRUMENT && (
              <NewInstrumentForm defaultCurrency={accountCurrency} onResolved={setNewSpec} />
            )}
```

- [ ] **Step 5: Gate the trade fields until the new instrument is resolved**

The security trade fields render in the final `else` branch of the `instrumentId === "" ? … : isCurrencyMode ? … : ( … )` expression (lines 324-376). Wrap that branch so that for a brand-new instrument it only shows once `newSpec` is set. Change the branch condition by replacing the opening of that final `: (` with a guard:

```tsx
            ) : instrumentId === NEW_INSTRUMENT && !newSpec ? (
              <p className="text-sm text-muted-foreground">
                Look up a symbol or ISIN above (or add one manually) to continue.
              </p>
            ) : (
```

(i.e. insert this new ternary arm immediately before the existing final `: (` that begins the Side/Units/Price block.)

- [ ] **Step 6: Create the instrument from the spec on submit**

In `onSubmit`, replace the `if (values.instrumentId === NEW_INSTRUMENT) { … }` block (lines 155-165) with:

```ts
      if (values.instrumentId === NEW_INSTRUMENT) {
        if (!newSpec) return;
        const { data, error } = await api.instruments.post({
          name: newSpec.name,
          kind: newSpec.kind,
          currency: newSpec.currency,
          symbol: newSpec.symbol ?? undefined,
          isin: newSpec.isin ?? undefined,
        });
        if (error || !data || !("id" in data) || !data.id) throw new Error(String(error ?? "instrument create failed"));
        id = data.id;
        await instrumentsCollection.utils.refetch();
        if (newSpec.symbol || newSpec.isin) {
          await api["market-data"].instrument({ id: data.id }).refresh.post({ backfill: true });
        }
      }
```

Also update the `secCurrency` line inside the security branch of `onSubmit` (line 170-171) to prefer the spec:

```ts
      const secCurrency =
        values.instrumentId === NEW_INSTRUMENT ? newSpec!.currency : sel?.currency ?? accountCurrency;
```

- [ ] **Step 7: Require a resolved spec before enabling Add**

Update the submit button's `disabled` (line 392) from `disabled={!instrumentId}` to:

```tsx
            <Button type="submit" disabled={!instrumentId || (instrumentId === NEW_INSTRUMENT && !newSpec)}>Add</Button>
```

- [ ] **Step 8: Remove the dead `newInstr` form field**

Remove `newInstr` from the `FormValues` type (line 35) and from `defaults()` (line 60). Remove the now-unused `instrumentKindLabel` import if nothing else in the file uses it (search the file first). Keep `Select`/`SelectItem` imports — they are still used by the instrument picker and Side/Cash selects.

- [ ] **Step 9: Typecheck**

Run: `cd apps/web && bun run build`
Expected: build succeeds with no unused-symbol or type errors. Fix any leftover references to `newInstr` or `newInstrCurrency` the compiler flags.

- [ ] **Step 10: Manual smoke check**

In an account, **Add transaction → New instrument…**. Expected: the Symbol/ISIN/Manual form appears; the Side/Units/Price fields stay hidden until a preview is confirmed (or manual fields filled); submitting creates the instrument + transaction together and the instrument shows a provider price after the backfill.

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/components/add-transaction-dialog.tsx
git commit -m "feat(web): Add-transaction uses NewInstrumentForm for new instruments"
```

---

### Task 5: E2E coverage (affected specs only)

**Files:**
- Modify: `apps/web/e2e/instruments.spec.ts` and/or `apps/web/e2e/transactions.spec.ts` (follow `e2e/README.md`)

The lookup hits live Yahoo, which e2e must not depend on. Use the repo's existing network-mocking approach for Yahoo (see how `market-data`/instruments e2e or the test fixtures stub provider endpoints; mirror that). If no provider mock exists in e2e, cover the deterministic paths instead: (a) **Manual** mode creates an instrument from `/instruments` with no price; (b) Add-transaction with Manual mode creates instrument + transaction. Gate the lookup-path assertion behind the same mock the rest of the suite uses, or omit it if the suite has no provider mock.

- [ ] **Step 1: Add the e2e test(s)** per the above, using `data-testid`s introduced here: `add-instrument`, `add-instrument-submit`, `ni-mode-symbol`, `ni-mode-isin`, `ni-query`, `ni-find`, `ni-preview`, `ni-error`, `ni-manual-name`, `ni-manual-currency`.

- [ ] **Step 2: Run the affected specs**

Run: `cd apps/web && bun run e2e -- instruments.spec.ts transactions.spec.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/e2e
git commit -m "test(e2e): add-instrument Symbol/ISIN/Manual flows"
```

---

## Self-Review notes

- **Spec coverage:** lookup endpoint (Task 1) ✓; 3-mode shared form with read-only preview (Task 2) ✓; standalone `/instruments` add + backfill (Task 3) ✓; Add-transaction integration, create-on-final-Add (Task 4) ✓; nudge-to-Manual on miss (Task 2 `find()` error path) ✓; no resolver change / no migration (nothing touches `resolveUncached` or instrument rows) ✓; quoteType→kind map (Task 1 `kindFromQuoteType`) ✓; e2e (Task 5) ✓.
- **Type consistency:** `NewInstrumentSpec`/`Kind` defined in Task 2 are imported unchanged by Tasks 3-4; `InstrumentLookupResult` defined in Task 1 drives the route JSON consumed in Task 2; `api.instruments.post` accepts `symbol`/`isin` as `string | undefined` (route body uses `t.Optional`), so `?? undefined` is correct.
- **Decisions honored:** Symbol mode stores `resolvedSymbol`; ISIN mode stores the entered ISIN (upper-cased) and `symbol: null`; Manual stores neither.
- **Known limitation (documented, not a placeholder):** `AddInstrumentDialog` passes `defaultCurrency="USD"` for Manual mode's initial currency (lookup modes override it from the provider). Acceptable for v1; the field is editable.
- **No placeholders:** all app/test code is concrete; only the e2e bodies defer to repo-specific harness/mock conventions per `e2e/README.md`, which is the established pattern in this codebase.
