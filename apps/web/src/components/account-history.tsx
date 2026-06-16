import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import { Money } from "@/components/money.tsx";
import { UpdatePrice } from "@/components/update-price";
import { EditTransactionDialog } from "@/components/edit-transaction-dialog";
import { transactionsCollection, type TransactionRow } from "@/lib/collections";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

const SCALE = 100_000_000;
const fmtUnits = (scaled: number) => String(scaled / SCALE);

type Position = {
  instrument: { id: string; symbol: string | null; name: string; kind: string; currency: string };
  instrumentCurrency: string;
  units: number;
  currentPriceScaled: number | null;
  marketValueMinor: number;
  unrealizedGainMinor: number;
  valueDisplayMinor: number;
  missingPrice: boolean;
};

type Positions = {
  accountCurrency: string;
  baseCurrency: string;
  totalMinor: number;
  totalBaseMinor: number;
  missing: boolean;
  positions: Position[];
};

// Account value + positions. Shared by the header total and the Positions tab
// (React Query dedupes the request by key).
export function usePositions(accountId: string) {
  return useQuery({
    queryKey: ["positions", accountId],
    queryFn: async (): Promise<Positions> => {
      const { data, error } = await api.accounts({ id: accountId }).positions.get();
      if (error) throw new Error(String(error));
      return data as unknown as Positions;
    },
  });
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card/40 px-4 py-10 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

export function PositionsPanel({ accountId, accountCurrency }: { accountId: string; accountCurrency: string }) {
  const { data: pos } = usePositions(accountId);
  // Show any open position, including negative ones (a liability's debt is a
  // negative cash position). Only fully-closed (zero-unit) positions are hidden.
  const positions = (pos?.positions ?? []).filter((p) => p.units !== 0);

  if (positions.length === 0) {
    return <EmptyState>Nothing held yet. Add a transaction to build a position.</EmptyState>;
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      {positions.map((p, i) => {
        const isCash = p.instrument.kind === "currency";
        return (
          <div
            key={p.instrument.id}
            data-testid="position-row"
            className={cn(
              "group flex items-center justify-between gap-4 px-4 py-3",
              i > 0 && "border-t border-border/70",
            )}
          >
            <div className="min-w-0">
              <p className="truncate font-medium">
                {p.instrument.symbol ? `${p.instrument.symbol} · ` : ""}
                {p.instrument.name}
                <span className="ml-2 rounded-full bg-muted px-1.5 py-0.5 text-[0.65rem] font-medium text-muted-foreground">
                  {isCash ? "cash" : p.instrument.kind}
                </span>
              </p>
              <p className="text-xs text-muted-foreground">
                {fmtUnits(p.units)} {isCash ? p.instrument.currency : "units"}
                {p.missingPrice && (
                  <span className="ml-1.5 rounded-full bg-destructive/10 px-1.5 py-0.5 text-[0.65rem] font-medium text-destructive">
                    no price
                  </span>
                )}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <div className="shrink-0 text-right tabular-nums">
                <p className="font-medium">
                  {p.missingPrice ? "—" : <Money minor={p.valueDisplayMinor} currency={accountCurrency} />}
                </p>
                {!isCash && !p.missingPrice && (
                  <p
                    className={cn(
                      "text-xs",
                      p.unrealizedGainMinor < 0 ? "text-destructive" : "text-muted-foreground",
                    )}
                  >
                    {p.unrealizedGainMinor >= 0 ? "+" : ""}
                    <Money minor={p.unrealizedGainMinor} currency={p.instrumentCurrency} />
                  </p>
                )}
              </div>
              {!isCash && (
                <div className="opacity-0 transition-opacity group-hover:opacity-100">
                  <UpdatePrice instrumentId={p.instrument.id} accountId={accountId} label="Price" />
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function HistoryPanel({ accountId }: { accountId: string }) {
  const txCollection = transactionsCollection(accountId);
  const { data: txns } = useLiveQuery(txCollection);
  const [editing, setEditing] = useState<TransactionRow | null>(null);

  const sortedTxns = [...(txns ?? [])].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  if (sortedTxns.length === 0) {
    return <EmptyState>No transactions recorded yet.</EmptyState>;
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      {sortedTxns.map((t, i) => {
        const isCash = t.instrument.kind === "currency";
        const amountMajor = t.unitsDelta / SCALE;
        return (
          <div
            key={t.id}
            data-testid="tx-row"
            role="button"
            tabIndex={0}
            onClick={() => setEditing(t)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setEditing(t);
              }
            }}
            className={cn(
              "flex cursor-pointer items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-muted/50",
              i > 0 && "border-t border-border/70",
            )}
          >
            <div className="min-w-0">
              <p className="truncate font-medium">
                {t.instrument.symbol ? `${t.instrument.symbol} · ` : ""}
                {t.instrument.name}
              </p>
              <p className="text-xs text-muted-foreground">
                {t.date}
                {t.notes ? ` · ${t.notes}` : ""}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <p className={cn("shrink-0 tabular-nums", t.unitsDelta < 0 && "text-destructive")}>
                {t.unitsDelta >= 0 ? "+" : ""}
                {amountMajor} {isCash ? t.instrument.currency : "units"}
              </p>
            </div>
          </div>
        );
      })}
      {editing && (
        <EditTransactionDialog
          accountId={accountId}
          tx={editing}
          open={editing != null}
          onOpenChange={(o) => !o && setEditing(null)}
        />
      )}
    </div>
  );
}
