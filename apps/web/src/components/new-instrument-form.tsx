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

type Candidate = {
  resolvedSymbol: string;
  name: string;
  kind: Kind;
  currency: string;
  price: number;
  date: string;
  exchange: string;
};

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
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<string | null>(null); // resolvedSymbol
  const [mName, setMName] = useState("");
  const [mCurrency, setMCurrency] = useState(defaultCurrency);
  const [mKind, setMKind] = useState<Kind>("stock");

  function clearResults() {
    setCandidates([]);
    setSelected(null);
    setError("");
    onResolved(null);
  }

  function switchMode(next: Mode) {
    setMode(next);
    setQuery("");
    clearResults();
    if (next === "manual") publishManual(mName, mCurrency, mKind);
  }

  function publishManual(name: string, currency: string, kind: Kind) {
    const ok = name.trim().length > 0 && /^[A-Za-z]{3}$/.test(currency.trim());
    onResolved(ok ? { name: name.trim(), kind, currency: currency.trim().toUpperCase(), symbol: null, isin: null } : null);
  }

  // Whichever listing the user picks, store its concrete (exchange-qualified)
  // resolved symbol so "Update prices" fetches exactly that listing — the resolver
  // prefers an explicit symbol over re-searching, so the pick is honoured even when
  // we also record the ISIN. In ISIN mode we keep the ISIN for reference.
  function selectCandidate(c: Candidate) {
    setSelected(c.resolvedSymbol);
    onResolved({
      name: c.name, kind: c.kind, currency: c.currency,
      symbol: c.resolvedSymbol,
      isin: mode === "isin" ? query.trim().toUpperCase() : null,
    });
  }

  async function find() {
    clearResults();
    const q = query.trim().toUpperCase();
    if (!q) return;
    if (mode === "isin" && !ISIN_RE.test(q)) {
      setError("That doesn't look like a valid ISIN (e.g. LU2420246139).");
      return;
    }
    setFinding(true);
    const { data, error: err } = await api["market-data"].lookup.post({ query: q });
    setFinding(false);
    if (err || !data || !("candidates" in data) || data.candidates.length === 0) {
      setError("No match found. Try Manual entry to add it with a price you set yourself.");
      return;
    }
    const list = data.candidates as Candidate[];
    setCandidates(list);
    selectCandidate(list[0]); // preselect the best match; user can change it
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
            onChange={(e) => { setQuery(e.target.value); clearResults(); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); find(); } }}
          />
        </Field>
        <Button type="button" variant="outline" data-testid="ni-find" disabled={finding || !query.trim()} onClick={find}>
          {finding ? "Finding…" : "Find"}
        </Button>
      </div>

      {error && <p className="text-sm text-destructive" data-testid="ni-error">{error}</p>}

      {candidates.length > 0 && (
        <div className="space-y-1.5" data-testid="ni-candidates">
          {candidates.length > 1 && (
            <p className="text-xs text-muted-foreground">{candidates.length} matches — pick the right listing:</p>
          )}
          <div className="overflow-hidden rounded-md border border-border">
            {candidates.map((c, i) => {
              const isSel = selected === c.resolvedSymbol;
              return (
                <button
                  key={c.resolvedSymbol}
                  type="button"
                  data-testid="ni-candidate"
                  onClick={() => selectCandidate(c)}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors",
                    i > 0 && "border-t border-border/70",
                    isSel ? "bg-muted/70" : "hover:bg-muted/40",
                  )}
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className={cn("size-2 shrink-0 rounded-full", isSel ? "bg-primary" : "bg-transparent ring-1 ring-border")} />
                      <span className="truncate font-medium">{c.resolvedSymbol} · {c.name}</span>
                      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[0.65rem] font-medium text-muted-foreground">
                        {instrumentKindLabel(c.kind)}
                      </span>
                    </span>
                    <span className="ml-4 block text-xs text-muted-foreground">
                      {c.exchange ? `${c.exchange} · ` : ""}as of {c.date}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums">{c.price} {c.currency}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <Button type="button" variant="ghost" size="sm" onClick={() => switchMode("manual")}>
        Can't find it? Add manually
      </Button>
    </div>
  );
}
