import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { SCALE, currencyDecimals } from "@uang/shared";
import { transactionsCollection, type TransactionRow } from "@/lib/collections";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

const S = Number(SCALE);

export function EditTransactionDialog({
  accountId,
  tx,
  open,
  onOpenChange,
}: {
  accountId: string;
  tx: TransactionRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const isCash = tx.instrument.kind === "currency";
  const dec = currencyDecimals(tx.instrument.currency);

  // Cash transactions edit a single signed amount; securities edit units + price + fees.
  const [amount, setAmount] = useState(String(tx.unitsDelta / S));
  const [price, setPrice] = useState(tx.unitPriceScaled != null ? String(tx.unitPriceScaled / S) : "");
  const [fees, setFees] = useState(tx.feesMinor ? String(tx.feesMinor / 10 ** dec) : "");
  const [date, setDate] = useState(tx.date);
  const [notes, setNotes] = useState(tx.notes ?? "");

  const amountNum = parseFloat(amount);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (Number.isNaN(amountNum)) return;
    const p = parseFloat(price);
    const fee = parseFloat(fees);

    await transactionsCollection(accountId).update(tx.id, (draft) => {
      draft.date = date;
      draft.unitsDelta = Math.round(amountNum * S);
      draft.notes = notes || null;
      if (!isCash) {
        if (!Number.isNaN(p)) draft.unitPriceScaled = Math.round(p * S);
        draft.feesMinor = Number.isNaN(fee) ? 0 : Math.round(fee * 10 ** dec);
      }
    });

    await qc.invalidateQueries({ queryKey: ["positions", accountId] });
    await qc.invalidateQueries({ queryKey: ["networth"] });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Edit transaction · {tx.instrument.symbol ? `${tx.instrument.symbol} — ` : ""}{tx.instrument.name}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          {isCash ? (
            <Field label="Amount (+ add, − subtract)">
              <Input
                data-testid="edit-tx-amount" type="number" step="any" value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className={cn("tabular-nums", !Number.isNaN(amountNum) && (amountNum < 0 ? "text-destructive" : "text-emerald-600"))}
                required
              />
            </Field>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <Field label="Units (+ buy, − sell)">
                <Input data-testid="edit-tx-units" type="number" step="any" value={amount}
                       onChange={(e) => setAmount(e.target.value)} required />
              </Field>
              <Field label={`Price (${tx.instrument.currency})`}>
                <Input data-testid="edit-tx-price" type="number" step="any" value={price}
                       onChange={(e) => setPrice(e.target.value)} />
              </Field>
              <Field label="Fees">
                <Input data-testid="edit-tx-fees" type="number" step="any" value={fees}
                       onChange={(e) => setFees(e.target.value)} placeholder="optional" />
              </Field>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <Field label="Date">
              <Input data-testid="edit-tx-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
            </Field>
            <Field label="Notes">
              <Input data-testid="edit-tx-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" />
            </Field>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit">Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
