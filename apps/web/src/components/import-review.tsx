import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { currencyDecimals } from "@uang/shared";
import { api } from "@/lib/api";
import { transactionsCollection } from "@/lib/collections";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

type Row = {
  id: string; date: string | null; amountMinor: number | null;
  description: string; status: "new" | "duplicate" | "excluded" | "error"; errorReason: string | null;
};
type Batch = { id: string; accountId: string; rows: Row[] };

function fmt(minor: number | null, currency: string): string {
  if (minor === null) return "—";
  return (minor / 10 ** currencyDecimals(currency)).toLocaleString(undefined, {
    minimumFractionDigits: currencyDecimals(currency), maximumFractionDigits: currencyDecimals(currency),
  });
}

export function ImportReview({ batchId, accountCurrency, onDone }: {
  batchId: string; accountCurrency: string; onDone: () => void;
}) {
  const qc = useQueryClient();
  const [batch, setBatch] = useState<Batch | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.imports({ id: batchId }).get().then(({ data }) => {
      if (!cancelled && data && "rows" in data) setBatch(data as Batch);
    });
    return () => { cancelled = true; };
  }, [batchId]);

  if (!batch) return <div className="py-8 text-center text-muted-foreground">Loading…</div>;

  async function toggle(row: Row, include: boolean) {
    const status = include ? "new" : "excluded";
    await api["import-rows"]({ id: row.id }).patch({ status });
    setBatch((b) => b && { ...b, rows: b.rows.map((r) => r.id === row.id ? { ...r, status } : r) });
  }

  async function commit() {
    setBusy(true);
    try {
      const { error } = await api.imports({ id: batchId }).commit.post();
      if (error) throw new Error(String(error));
      await transactionsCollection(batch!.accountId).utils.refetch();
      await qc.invalidateQueries({ queryKey: ["accounts"] });
      onDone();
    } finally {
      setBusy(false);
    }
  }

  const includable = batch.rows.filter((r) => r.status === "new").length;
  const dupes = batch.rows.filter((r) => r.status === "duplicate").length;
  const errors = batch.rows.filter((r) => r.status === "error").length;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {includable} to import · {dupes} duplicates skipped · {errors} errors
      </p>
      <div className="max-h-[50vh] overflow-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10" />
              <TableHead>Date</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {batch.rows.map((r) => (
              <TableRow key={r.id} data-testid="import-row">
                <TableCell>
                  <Checkbox
                    checked={r.status === "new"}
                    disabled={r.status === "error" || r.status === "duplicate"}
                    onCheckedChange={(v) => toggle(r, v === true)}
                    data-testid="import-row-include"
                  />
                </TableCell>
                <TableCell>{r.date ?? "—"}</TableCell>
                <TableCell>{r.description}</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(r.amountMinor, accountCurrency)}</TableCell>
                <TableCell className="text-muted-foreground">{r.errorReason ?? r.status}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>Cancel</Button>
        <Button onClick={commit} disabled={busy || includable === 0} data-testid="import-commit">
          {busy ? "Importing…" : `Import ${includable}`}
        </Button>
      </div>
    </div>
  );
}
