import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import { AppShell } from "@/components/app-layout";
import { PageHeader } from "@/components/page-header";
import { EditTransactionDialog } from "@/components/edit-transaction-dialog";
import { transactionsCollection, type TransactionRow } from "@/lib/collections";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

const SCALE = 100_000_000;

// The all-accounts row is the per-account TransactionRow plus an `account`.
type AllTxRow = TransactionRow & { account: { id: string; name: string; currency: string } };

function useAllTransactions() {
  return useQuery({
    queryKey: ["transactions", "all"],
    queryFn: async (): Promise<AllTxRow[]> => {
      const { data, error } = await api.transactions.get();
      if (error) throw new Error(String(error));
      return (Array.isArray(data) ? data : []) as AllTxRow[];
    },
  });
}

// Subscribe to the owning account's collection so EditTransactionDialog's
// optimistic update/delete can find the row, then render the dialog.
function EditTxPortal({ row, onClose }: { row: AllTxRow; onClose: () => void }) {
  useLiveQuery(transactionsCollection(row.account.id));
  return (
    <EditTransactionDialog
      accountId={row.account.id}
      tx={row}
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
    />
  );
}

export function TransactionsPage() {
  const qc = useQueryClient();
  const { data: rows, isLoading } = useAllTransactions();
  const [editing, setEditing] = useState<AllTxRow | null>(null);

  function closeEditor() {
    setEditing(null);
    // Refresh the all-list (and per-account collections) after an edit/delete.
    qc.invalidateQueries({ queryKey: ["transactions"] });
  }

  return (
    <AppShell>
      <PageHeader eyebrow="Activity" title="Transactions" />
      {isLoading ? (
        <p className="mt-6 text-muted-foreground">Loading…</p>
      ) : (rows ?? []).length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-border bg-card/40 px-4 py-10 text-center text-sm text-muted-foreground">
          No transactions recorded yet.
        </div>
      ) : (
        <div className="mt-6 overflow-hidden rounded-xl border border-border bg-card">
          {(rows ?? []).map((t, i) => {
            const isCash = t.instrument.kind === "currency";
            const amountMajor = t.unitsDelta / SCALE;
            return (
              <div
                key={t.id}
                data-testid="all-tx-row"
                role="button"
                tabIndex={0}
                onClick={() => setEditing(t)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setEditing(t); }
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
                    {t.date} · {t.account.name}
                    {t.notes ? ` · ${t.notes}` : ""}
                  </p>
                </div>
                <p className={cn("shrink-0 tabular-nums", t.unitsDelta < 0 && "text-destructive")}>
                  {t.unitsDelta >= 0 ? "+" : ""}
                  {amountMajor} {isCash ? t.instrument.currency : "units"}
                </p>
              </div>
            );
          })}
        </div>
      )}
      {editing && <EditTxPortal row={editing} onClose={closeEditor} />}
    </AppShell>
  );
}
