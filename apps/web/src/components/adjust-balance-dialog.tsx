import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { SCALE, currencyDecimals } from "@uang/shared";
import { instrumentsCollection, transactionsCollection, newId } from "@/lib/collections";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { MoneyInput } from "@/components/ui/money-input";
import { Field } from "@/components/ui/field";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger,
} from "@/components/ui/responsive-dialog";

const S = Number(SCALE);
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Sets the account's cash balance to a target by posting a single cash
 * transaction for the difference (target − current). The account-currency cash
 * position is the thing adjusted, so the delta lands in the account currency and
 * the header total moves to the entered amount.
 */
export function AdjustBalanceDialog({
  accountId,
  accountCurrency,
  currentMinor,
}: {
  accountId: string;
  accountCurrency: string;
  currentMinor: number;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const dec = currencyDecimals(accountCurrency);
  const currentMajor = (currentMinor / 10 ** dec).toFixed(dec);
  const [target, setTarget] = useState(currentMajor);

  function openChange(v: boolean) {
    setOpen(v);
    if (v) setTarget(currentMajor); // reseed from the latest balance each open
  }

  async function ensureCurrencyId(): Promise<string> {
    const { data, error } = await api.instruments.currency.post({ symbol: accountCurrency.toUpperCase() });
    if (error || !data || !("id" in data)) throw new Error(String(error ?? "currency create failed"));
    await instrumentsCollection.utils.refetch();
    return data.id;
  }

  async function onSubmit() {
    const targetMajor = parseFloat(target);
    if (Number.isNaN(targetMajor)) return;
    const deltaMajor = targetMajor - currentMinor / 10 ** dec;
    const unitsDelta = Math.round(deltaMajor * S);
    if (unitsDelta === 0) {
      setOpen(false);
      return;
    }

    const currencyId = await ensureCurrencyId();
    const { error } = await api.accounts({ id: accountId }).transactions.post({
      id: newId(),
      instrumentId: currencyId,
      date: today(),
      unitsDelta,
      unitPriceScaled: S,
      notes: "Adjusted balance",
    });
    if (error) throw new Error(String(error));

    await transactionsCollection(accountId).utils.refetch();
    await qc.invalidateQueries({ queryKey: ["positions", accountId] });
    await qc.invalidateQueries({ queryKey: ["networth"] });
    await qc.invalidateQueries({ queryKey: ["holdings"] });
    setOpen(false);
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={openChange}>
      <ResponsiveDialogTrigger render={<Button variant="outline" />}>Adjust balance</ResponsiveDialogTrigger>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Adjust balance</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void onSubmit();
          }}
          className="flex min-h-0 flex-1 flex-col"
        >
          <ResponsiveDialogBody className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Records a cash transaction for the difference and brings the balance to this amount.
            </p>
            <Field label={`New balance (${accountCurrency})`}>
              <MoneyInput
                data-testid="adjust-balance-amount"
                currency={accountCurrency}
                value={target}
                onChange={setTarget}
                required
              />
            </Field>
          </ResponsiveDialogBody>

          <ResponsiveDialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit">Adjust</Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
