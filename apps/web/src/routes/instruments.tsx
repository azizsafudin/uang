import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import { AppShell } from "@/components/app-layout";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { instrumentsCollection } from "@/lib/collections";
import { AddInstrumentDialog } from "@/components/add-instrument-dialog";
import { formatMoney } from "@/components/money.ts";
import { formatDate } from "@/lib/utils";
import { SCALE, currencyDecimals } from "@uang/shared";

const S = Number(SCALE);

function priceLabel(kind: string, scaled: number | null, currency: string): string {
  if (kind === "currency") return "1.00 (implicit)";
  if (scaled === null) return "—";
  return formatMoney(Math.round((scaled / S) * 10 ** currencyDecimals(currency)), currency);
}

export function InstrumentsPage() {
  const { data: instruments, isLoading } = useLiveQuery(instrumentsCollection);
  const rows = [...(instruments ?? [])].sort((a, b) => a.name.localeCompare(b.name));

  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  // Single action: bring every instrument price and FX rate up to date, fetching only
  // the dates missing since the last stored value (incremental backfill).
  async function updatePrices() {
    setBusy(true); setMsg("Updating…");
    const [prices, fx] = await Promise.all([
      api["market-data"].instruments.refresh.post({ backfill: true }),
      api["market-data"].fx.refresh.post({ backfill: true }),
    ]);
    const p = prices.data, f = fx.data;
    if (p && "updated" in p && f && "updated" in f) {
      const rows = p.rowsWritten + f.rowsWritten;
      const issues = p.unsupported + p.failed + f.unsupported + f.failed;
      setMsg(rows === 0 && issues === 0 ? "Already up to date" : `${rows} new price${rows === 1 ? "" : "s"}${issues > 0 ? ` · ${issues} unsupported/failed` : ""}`);
    } else {
      setMsg("Update failed");
    }
    await qc.invalidateQueries({ queryKey: ["instruments"] });
    await qc.invalidateQueries({ queryKey: ["fx"] });
    await qc.invalidateQueries({ queryKey: ["networth"] });
    await qc.invalidateQueries({ queryKey: ["holdings"] });
    setBusy(false);
  }

  return (
    <AppShell>
      <PageHeader eyebrow="Holdings" title="Instruments" />
      <div className="mt-2 mb-5 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={updatePrices} data-testid="update-prices">
          {busy ? "Updating…" : "Update prices"}
        </Button>
        <AddInstrumentDialog defaultCurrency="USD" />
        {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
      </div>
      {isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card/40 px-4 py-10 text-center text-sm text-muted-foreground">
          No instruments yet. They are created when you log a transaction.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {rows.map((i, idx) => (
            <Link
              key={i.id}
              to="/instruments/$id"
              params={{ id: i.id }}
              data-testid="instrument-row"
              className={`flex items-center justify-between gap-4 px-4 py-3 hover:bg-muted/40 ${idx > 0 ? "border-t border-border/70" : ""}`}
            >
              <div className="min-w-0">
                <p className="truncate font-medium">
                  {i.symbol ? `${i.symbol} · ` : ""}{i.name}
                  <span className="ml-2 rounded-full bg-muted px-1.5 py-0.5 text-[0.65rem] font-medium text-muted-foreground">
                    {i.kind === "currency" ? "cash" : i.kind}
                  </span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {i.currency} · {i.holderCount} {i.holderCount === 1 ? "account" : "accounts"}
                </p>
              </div>
              <div className="shrink-0 text-right tabular-nums text-sm">
                <p className="font-medium">{priceLabel(i.kind, i.latestPriceScaled, i.currency)}</p>
                {i.latestPriceDate && <p className="text-xs text-muted-foreground">as of {formatDate(i.latestPriceDate)}</p>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </AppShell>
  );
}
