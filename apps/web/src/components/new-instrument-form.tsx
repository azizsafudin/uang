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
    if (err || !data || !("name" in data) || !data.found) {
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
