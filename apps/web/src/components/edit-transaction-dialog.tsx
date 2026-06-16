import { useEffect } from "react";
import { useForm, Controller } from "react-hook-form";
import { useQueryClient } from "@tanstack/react-query";
import { SCALE, currencyDecimals } from "@uang/shared";
import { transactionsCollection, type TransactionRow } from "@/lib/collections";
import { useDestructiveAction } from "@/lib/use-destructive-action";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import { Field } from "@/components/ui/field";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog";

const S = Number(SCALE);

type FormValues = {
  amount: string;
  price: string;
  fees: string;
  date: string;
  notes: string;
};

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
  const { confirm, dialog: confirmDialog } = useDestructiveAction();
  const isCash = tx.instrument.kind === "currency";
  const dec = currencyDecimals(tx.instrument.currency);

  // Cash transactions edit a single signed amount; securities edit units + price + fees.
  const defaults = (): FormValues => ({
    amount: String(tx.unitsDelta / S),
    price: tx.unitPriceScaled != null ? String(tx.unitPriceScaled / S) : "",
    fees: tx.feesMinor ? String(tx.feesMinor / 10 ** dec) : "",
    date: tx.date,
    notes: tx.notes ?? "",
  });

  const { register, handleSubmit, control, watch, reset } = useForm<FormValues>({
    defaultValues: defaults(),
  });

  useEffect(() => {
    if (open) reset(defaults());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tx.id]);

  const amountNum = parseFloat(watch("amount"));

  async function onSubmit(values: FormValues) {
    if (Number.isNaN(parseFloat(values.amount))) return;
    const p = parseFloat(values.price);
    const fee = parseFloat(values.fees);

    await transactionsCollection(accountId).update(tx.id, (draft) => {
      draft.date = values.date;
      draft.unitsDelta = Math.round(parseFloat(values.amount) * S);
      draft.notes = values.notes || null;
      if (!isCash) {
        if (!Number.isNaN(p)) draft.unitPriceScaled = Math.round(p * S);
        draft.feesMinor = Number.isNaN(fee) ? 0 : Math.round(fee * 10 ** dec);
      }
    });

    await qc.invalidateQueries({ queryKey: ["positions", accountId] });
    await qc.invalidateQueries({ queryKey: ["networth"] });
    onOpenChange(false);
  }

  async function del() {
    await transactionsCollection(accountId).delete(tx.id);
    await qc.invalidateQueries({ queryKey: ["positions", accountId] });
    await qc.invalidateQueries({ queryKey: ["networth"] });
    onOpenChange(false);
  }

  return (
    <>
      {confirmDialog}
      <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
        <ResponsiveDialogContent>
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>
              Edit transaction · {tx.instrument.symbol ? `${tx.instrument.symbol} — ` : ""}
              {tx.instrument.name}
            </ResponsiveDialogTitle>
          </ResponsiveDialogHeader>
          <form onSubmit={handleSubmit(onSubmit)} className="flex min-h-0 flex-1 flex-col">
            <ResponsiveDialogBody className="space-y-4">
              {isCash ? (
                <Field label="Amount (+ add, − subtract)">
                  <Controller
                    control={control}
                    name="amount"
                    rules={{ required: true }}
                    render={({ field }) => (
                      <MoneyInput
                        data-testid="edit-tx-amount"
                        currency={tx.instrument.currency}
                        value={field.value}
                        onChange={field.onChange}
                        className={cn(
                          !Number.isNaN(amountNum) &&
                            (amountNum < 0 ? "text-destructive" : "text-emerald-600")
                        )}
                        required
                      />
                    )}
                  />
                </Field>
              ) : (
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Units (+ buy, − sell)">
                    <Input
                      data-testid="edit-tx-units"
                      type="number"
                      step="any"
                      required
                      {...register("amount", { required: true })}
                    />
                  </Field>
                  <Field label={`Price (${tx.instrument.currency})`}>
                    <Input data-testid="edit-tx-price" type="number" step="any" {...register("price")} />
                  </Field>
                  <Field label="Fees">
                    <Input
                      data-testid="edit-tx-fees"
                      type="number"
                      step="any"
                      placeholder="optional"
                      {...register("fees")}
                    />
                  </Field>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <Field label="Date">
                  <Input data-testid="edit-tx-date" type="date" required {...register("date", { required: true })} />
                </Field>
                <Field label="Notes">
                  <Input data-testid="edit-tx-notes" placeholder="optional" {...register("notes")} />
                </Field>
              </div>
            </ResponsiveDialogBody>

            <ResponsiveDialogFooter className="sm:justify-between">
              <Button
                type="button"
                variant="ghost"
                data-testid="edit-tx-delete"
                className="text-destructive hover:text-destructive"
                onClick={() =>
                  confirm({
                    title: "Delete transaction?",
                    description:
                      "This transaction will be permanently removed and the position recalculated.",
                    onConfirm: del,
                  })
                }
              >
                Delete
              </Button>
              <div className="flex flex-col-reverse gap-2 sm:flex-row">
                <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button type="submit">Save</Button>
              </div>
            </ResponsiveDialogFooter>
          </form>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </>
  );
}
