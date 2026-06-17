import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "@/lib/api";
import { Money } from "@/components/money.tsx";
import { instrumentKindLabel } from "@/components/labels";
import { AllocationDonut, type AllocationSlice } from "@/components/allocation-donut";

type Holdings = {
  baseCurrency: string;
  totalBaseMinor: number;
  byKind: { kind: string; valueBaseMinor: number }[];
  securities: {
    instrumentId: string; symbol: string | null; name: string; kind: string; currency: string;
    units: number; valueBaseMinor: number; unrealizedGainBaseMinor: number; accountCount: number; missing: boolean;
  }[];
  cash: { currency: string; valueBaseMinor: number; accountCount: number; missing: boolean }[];
};

async function fetchHoldings(owner: string): Promise<Holdings> {
  const { data, error } = await api.holdings.get({ query: { owner } });
  if (error) throw new Error(String(error));
  return data as unknown as Holdings;
}

const fmtUnits = (unitsScaled: number) =>
  (unitsScaled / 1e8).toLocaleString(undefined, { maximumFractionDigits: 4 });

const accts = (n: number) => `${n} account${n === 1 ? "" : "s"}`;

export function AssetsHoldingsTab({ owner }: { owner: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["holdings", owner],
    queryFn: () => fetchHoldings(owner),
  });

  const base = data?.baseCurrency ?? "";
  // byKind emits "cash" for the cash bucket; instrumentKindLabel keys on "currency".
  const kindLabel = (k: string) => (k === "cash" ? "Cash" : instrumentKindLabel(k));
  const slices: AllocationSlice[] = useMemo(
    () => (data?.byKind ?? []).map((b) => ({ label: kindLabel(b.kind), valueBaseMinor: b.valueBaseMinor })),
    [data],
  );

  if (isLoading) {
    return <div className="mt-6 h-48 animate-pulse rounded-2xl bg-muted/40" />;
  }
  if (!data || (data.securities.length === 0 && data.cash.length === 0)) {
    return <p className="mt-6 text-sm text-muted-foreground">No holdings yet.</p>;
  }

  return (
    <div className="mt-6 space-y-6">
      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Portfolio value</p>
        <p data-testid="holdings-total" className="font-heading text-2xl tabular-nums">
          <Money minor={data.totalBaseMinor} currency={base} />
        </p>
      </div>

      <AllocationDonut slices={slices} baseCurrency={base} />

      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2 text-left font-medium">Holding</th>
              <th className="px-4 py-2 text-right font-medium">Units</th>
              <th className="px-4 py-2 text-right font-medium">Value</th>
              <th className="px-4 py-2 text-right font-medium">% port</th>
              <th className="px-4 py-2 text-right font-medium">Unrealized</th>
            </tr>
          </thead>
          <tbody>
            {data.securities.length > 0 && (
              <tr><td colSpan={5} className="px-4 pt-3 pb-1 text-xs uppercase tracking-wide text-muted-foreground">Securities</td></tr>
            )}
            {data.securities.map((s) => {
              const pct = data.totalBaseMinor > 0 ? Math.round((s.valueBaseMinor / data.totalBaseMinor) * 100) : 0;
              const up = s.unrealizedGainBaseMinor >= 0;
              return (
                <tr key={s.instrumentId} data-testid="holding-row" className="border-b border-border/60 last:border-b-0 hover:bg-accent/40">
                  <td className="px-4 py-3">
                    <Link to="/instruments/$id" params={{ id: s.instrumentId }} className="block">
                      <span className="font-medium">{s.symbol ?? s.name}</span>
                      <span className="ml-2 rounded-full bg-accent px-2 py-0.5 text-[0.65rem] text-muted-foreground">
                        {instrumentKindLabel(s.kind)}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">{s.name} · {accts(s.accountCount)}</span>
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmtUnits(s.units)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {s.missing ? <span className="text-destructive">—</span> : <Money minor={s.valueBaseMinor} currency={base} />}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{pct}%</td>
                  <td className={cnGain(up)}>
                    {up ? "▲ " : "▼ "}<Money minor={Math.abs(s.unrealizedGainBaseMinor)} currency={base} />
                  </td>
                </tr>
              );
            })}

            {data.cash.length > 0 && (
              <tr><td colSpan={5} className="px-4 pt-3 pb-1 text-xs uppercase tracking-wide text-muted-foreground">Cash</td></tr>
            )}
            {data.cash.map((c) => {
              const pct = data.totalBaseMinor > 0 ? Math.round((c.valueBaseMinor / data.totalBaseMinor) * 100) : 0;
              return (
                <tr key={c.currency} data-testid="cash-row" className="border-b border-border/60 last:border-b-0">
                  <td className="px-4 py-3">
                    <span className="font-medium">{c.currency}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{accts(c.accountCount)}</span>
                  </td>
                  <td className="px-4 py-3 text-right text-muted-foreground">—</td>
                  <td className="px-4 py-3 text-right tabular-nums"><Money minor={c.valueBaseMinor} currency={base} /></td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{pct}%</td>
                  <td className="px-4 py-3 text-right text-muted-foreground">—</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Gain column color: pine for up, brick for down.
function cnGain(up: boolean): string {
  return `px-4 py-3 text-right tabular-nums ${up ? "text-primary" : "text-destructive"}`;
}
