import { useMemo, useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { useLiveQuery } from "@tanstack/react-db";
import { useQueryClient } from "@tanstack/react-query";
import { SCALE, currencyDecimals } from "@uang/shared";
import { accountsCollection, instrumentsCollection, transactionsCollection, newId } from "@/lib/collections";
import { api } from "@/lib/api";
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
  ResponsiveDialogTrigger,
} from "@/components/ui/responsive-dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { instrumentKindLabel } from "@/components/labels";

const S = Number(SCALE);
const NEW_CURRENCY = "__new_currency__";
const NEW_INSTRUMENT = "__new_instrument__";
const today = () => new Date().toISOString().slice(0, 10);

type FormValues = {
  instrumentId: string;
  newCurrency: string;
  newInstr: { name: string; symbol: string; currency: string; kind: string };
  amount: string;
  side: "buy" | "sell";
  units: string;
  price: string;
  fees: string;
  recordCash: boolean;
  cashCurrencyId: string;
  date: string;
  notes: string;
};

export function AddTransactionDialog({ accountId, accountCurrency }: { accountId: string; accountCurrency: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [splitApplied, setSplitApplied] = useState(false);
  const { data: instruments } = useLiveQuery(instrumentsCollection);
  const { data: accounts } = useLiveQuery(accountsCollection);

  const currencies = useMemo(() => (instruments ?? []).filter((i) => i.kind === "currency"), [instruments]);
  const securities = useMemo(() => (instruments ?? []).filter((i) => i.kind !== "currency"), [instruments]);

  const defaults = (): FormValues => ({
    instrumentId: "",
    newCurrency: accountCurrency,
    newInstr: { name: "", symbol: "", currency: accountCurrency, kind: "stock" },
    amount: "",
    side: "buy",
    units: "",
    price: "",
    fees: "",
    recordCash: true,
    cashCurrencyId: "",
    date: today(),
    notes: "",
  });

  const { register, handleSubmit, control, watch, setValue, reset } = useForm<FormValues>({
    defaultValues: defaults(),
  });

  function resetForm() {
    reset(defaults());
    setSplitApplied(false);
  }

  // Reactive reads driving conditional fields and derived hints.
  const instrumentId = watch("instrumentId");
  const amount = watch("amount");
  const units = watch("units");
  const price = watch("price");
  const fees = watch("fees");
  const side = watch("side");
  const recordCash = watch("recordCash");
  const newInstrCurrency = watch("newInstr.currency");

  const selected = (instruments ?? []).find((i) => i.id === instrumentId);
  const isCurrencyMode = instrumentId === NEW_CURRENCY || selected?.kind === "currency";
  const currencyModeCurrency =
    instrumentId === NEW_CURRENCY ? watch("newCurrency").toUpperCase() : selected?.currency ?? accountCurrency;

  const amountNum = parseFloat(amount);

  // Loan-payment helper: on a liability with an interest rate, a positive cash
  // payment is part interest, part principal. Only the principal pays down the
  // balance, so we suggest the principal amount and prefill the interest in the
  // note. One month of interest on the outstanding balance (matches projections).
  const acctRow = (accounts ?? []).find((a) => a.id === accountId);
  const dec = currencyDecimals(accountCurrency);
  const loanRateBps = acctRow?.class === "liability" ? acctRow.growthRateBps : 0;
  const outstandingMajor = acctRow ? Math.abs(acctRow.balanceMinor) / 10 ** dec : 0;
  const monthlyInterestMajor = (outstandingMajor * (loanRateBps / 10000)) / 12;
  const principalMajor = amountNum - monthlyInterestMajor;
  const showLoanSplit =
    isCurrencyMode &&
    loanRateBps > 0 &&
    (acctRow?.balanceMinor ?? 0) < 0 &&
    !Number.isNaN(amountNum) &&
    principalMajor > 0 &&
    !splitApplied;

  function applyLoanSplit() {
    setValue("amount", principalMajor.toFixed(dec));
    setValue("notes", `Interest: ${monthlyInterestMajor.toFixed(dec)} ${accountCurrency} (${loanRateBps / 100}%/yr)`);
    setSplitApplied(true);
  }

  const securityCurrency =
    instrumentId === NEW_INSTRUMENT ? newInstrCurrency.toUpperCase() : selected?.currency ?? accountCurrency;
  const cashAmount = (parseFloat(units) || 0) * (parseFloat(price) || 0) + (parseFloat(fees) || 0);

  async function ensureCurrencyId(symbol: string): Promise<string> {
    const { data, error } = await api.instruments.currency.post({ symbol: symbol.toUpperCase() });
    if (error || !data || !("id" in data)) throw new Error(String(error ?? "currency create failed"));
    await instrumentsCollection.utils.refetch();
    return data.id;
  }

  async function onSubmit(values: FormValues) {
    const sel = (instruments ?? []).find((i) => i.id === values.instrumentId);
    const isCash = values.instrumentId === NEW_CURRENCY || sel?.kind === "currency";

    if (isCash) {
      // Resolve the currency instrument id.
      let id = values.instrumentId;
      if (values.instrumentId === NEW_CURRENCY) id = await ensureCurrencyId(values.newCurrency);
      const amt = parseFloat(values.amount);
      if (Number.isNaN(amt) || amt === 0) return;
      const { error } = await api.accounts({ id: accountId }).transactions.post({
        id: newId(),
        instrumentId: id,
        date: values.date,
        unitsDelta: Math.round(amt * S),
        unitPriceScaled: S,
        notes: values.notes || undefined,
      });
      if (error) throw new Error(String(error));
    } else {
      // Resolve the security instrument id.
      let id = values.instrumentId;
      if (values.instrumentId === NEW_INSTRUMENT) {
        const { data, error } = await api.instruments.post({
          name: values.newInstr.name,
          kind: values.newInstr.kind as "stock" | "etf" | "fund" | "crypto" | "other",
          currency: values.newInstr.currency.toUpperCase(),
          symbol: values.newInstr.symbol || undefined,
        });
        if (error || !data || !("id" in data) || !data.id) throw new Error(String(error ?? "instrument create failed"));
        id = data.id;
        await instrumentsCollection.utils.refetch();
      }
      const u = parseFloat(values.units);
      const p = parseFloat(values.price);
      const fee = parseFloat(values.fees);
      if (Number.isNaN(u) || Number.isNaN(p)) return;
      const secCurrency =
        values.instrumentId === NEW_INSTRUMENT ? values.newInstr.currency.toUpperCase() : sel?.currency ?? accountCurrency;
      const secDec = currencyDecimals(secCurrency);
      const signedUnits = values.side === "buy" ? u : -u;
      const cash = u * p + (Number.isNaN(fee) ? 0 : fee);

      // Optional cash leg: a buy spends cash (negative), a sell receives cash (positive).
      let cashLeg: { instrumentId: string; unitsDelta: number } | undefined;
      if (values.recordCash) {
        const cashId = values.cashCurrencyId || (await ensureCurrencyId(secCurrency));
        const cashUnits = values.side === "buy" ? -cash : cash;
        cashLeg = { instrumentId: cashId, unitsDelta: Math.round(cashUnits * S) };
      }

      const { error } = await api.accounts({ id: accountId }).transactions.post({
        id: newId(),
        instrumentId: id,
        date: values.date,
        unitsDelta: Math.round(signedUnits * S),
        unitPriceScaled: Math.round(p * S),
        feesMinor: Number.isNaN(fee) ? 0 : Math.round(fee * 10 ** secDec),
        notes: values.notes || undefined,
        cashLeg,
      });
      if (error) throw new Error(String(error));
    }

    await transactionsCollection(accountId).utils.refetch();
    await qc.invalidateQueries({ queryKey: ["positions", accountId] });
    await qc.invalidateQueries({ queryKey: ["networth"] });
    setOpen(false);
    resetForm();
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) resetForm(); }}>
      <ResponsiveDialogTrigger render={<Button />}>Add transaction</ResponsiveDialogTrigger>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Add transaction</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="flex min-h-0 flex-1 flex-col">
          <ResponsiveDialogBody className="space-y-4">
            <Field label="Instrument">
              <Controller
                control={control}
                name="instrumentId"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={(v: string | null) => v && field.onChange(v)}>
                    <SelectTrigger className="w-full" data-testid="tx-instrument">
                      <SelectValue>
                        {(v: unknown) => {
                          const val = String(v);
                          if (val === NEW_CURRENCY) return "New currency…";
                          if (val === NEW_INSTRUMENT) return "New instrument…";
                          if (!val) return "Select instrument";
                          const i = (instruments ?? []).find((x) => x.id === val);
                          return i ? (i.symbol ? `${i.symbol} — ${i.name}` : i.name) : "Select";
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {/* Cash / currencies first */}
                      {currencies.map((i) => (
                        <SelectItem key={i.id} value={i.id}>{i.symbol} — {i.name} (cash)</SelectItem>
                      ))}
                      <SelectItem value={NEW_CURRENCY}>New currency…</SelectItem>
                      {securities.map((i) => (
                        <SelectItem key={i.id} value={i.id}>{i.symbol ? `${i.symbol} — ${i.name}` : i.name}</SelectItem>
                      ))}
                      <SelectItem value={NEW_INSTRUMENT}>New instrument…</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>

            {instrumentId === NEW_CURRENCY && (
              <Field label="Currency code">
                <Input data-testid="tx-new-currency" maxLength={3} required {...register("newCurrency", { required: true })} />
              </Field>
            )}

            {instrumentId === NEW_INSTRUMENT && (
              <div className="grid grid-cols-2 gap-4 rounded-lg border border-border p-3">
                <Field label="Name" className="col-span-2">
                  <Input data-testid="tx-instr-name" required {...register("newInstr.name", { required: true })} />
                </Field>
                <Field label="Symbol">
                  <Input data-testid="tx-instr-symbol" placeholder="optional" {...register("newInstr.symbol")} />
                </Field>
                <Field label="Currency">
                  <Input data-testid="tx-instr-currency" maxLength={3} required {...register("newInstr.currency", { required: true })} />
                </Field>
                <Field label="Kind" className="col-span-2">
                  <Controller
                    control={control}
                    name="newInstr.kind"
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={(v: string | null) => v && field.onChange(v)}>
                        <SelectTrigger className="w-full"><SelectValue>{(v: unknown) => instrumentKindLabel(String(v))}</SelectValue></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="stock">{instrumentKindLabel("stock")}</SelectItem>
                          <SelectItem value="etf">{instrumentKindLabel("etf")}</SelectItem>
                          <SelectItem value="fund">{instrumentKindLabel("fund")}</SelectItem>
                          <SelectItem value="crypto">{instrumentKindLabel("crypto")}</SelectItem>
                          <SelectItem value="other">{instrumentKindLabel("other")}</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  />
                </Field>
              </div>
            )}

            {instrumentId === "" ? (
              <p className="text-sm text-muted-foreground">
                Pick an instrument above — cash to record a deposit or withdrawal, or a security to buy or sell.
              </p>
            ) : isCurrencyMode ? (
              <>
                <Field label="Amount (+ add, − subtract)">
                  <Controller
                    control={control}
                    name="amount"
                    rules={{ required: true }}
                    render={({ field }) => (
                      <MoneyInput
                        data-testid="tx-amount"
                        currency={currencyModeCurrency}
                        value={field.value}
                        onChange={(v) => { field.onChange(v); setSplitApplied(false); }}
                        className={cn(
                          !Number.isNaN(amountNum) && (amountNum < 0 ? "text-destructive" : "text-emerald-600")
                        )}
                        required
                      />
                    )}
                  />
                </Field>
                {showLoanSplit && (
                  <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
                    <p className="text-muted-foreground">
                      Loan payment: ~{monthlyInterestMajor.toFixed(dec)} {accountCurrency} interest this month ·{" "}
                      {principalMajor.toFixed(dec)} principal.
                    </p>
                    <Button type="button" variant="outline" size="sm" className="mt-2"
                            data-testid="tx-loan-split"
                            onClick={applyLoanSplit}>
                      Use principal {principalMajor.toFixed(dec)} + note interest
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <>
                <Field label="Side">
                  <Controller
                    control={control}
                    name="side"
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={(v: string | null) => v && field.onChange(v as "buy" | "sell")}>
                        <SelectTrigger className="w-full" data-testid="tx-side"><SelectValue>{(v: unknown) => String(v) === "sell" ? "Sell" : "Buy"}</SelectValue></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="buy">Buy</SelectItem>
                          <SelectItem value="sell">Sell</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  />
                </Field>
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Units">
                    <Input data-testid="tx-units" type="number" step="any" required {...register("units", { required: true })} />
                  </Field>
                  <Field label={`Price (${securityCurrency})`}>
                    <Input data-testid="tx-price" type="number" step="any" required {...register("price", { required: true })} />
                  </Field>
                  <Field label="Fees">
                    <Input data-testid="tx-fees" type="number" step="any" placeholder="optional" {...register("fees")} />
                  </Field>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" data-testid="tx-record-cash" {...register("recordCash")} />
                  Also record cash {side === "buy" ? "outflow" : "inflow"} ({side === "buy" ? "−" : "+"}{cashAmount.toFixed(2)} {securityCurrency})
                </label>
                {recordCash && currencies.length > 0 && (
                  <Field label="Cash from">
                    <Controller
                      control={control}
                      name="cashCurrencyId"
                      render={({ field }) => (
                        <Select value={field.value} onValueChange={(v: string | null) => v && field.onChange(v)}>
                          <SelectTrigger className="w-full"><SelectValue>{(v: unknown) => {
                            const i = currencies.find((c) => c.id === String(v));
                            return i ? `${i.symbol} — ${i.name}` : `${securityCurrency} (auto)`;
                          }}</SelectValue></SelectTrigger>
                          <SelectContent>
                            {currencies.map((i) => (<SelectItem key={i.id} value={i.id}>{i.symbol} — {i.name}</SelectItem>))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </Field>
                )}
              </>
            )}

            <div className="grid grid-cols-2 gap-4">
              <Field label="Date">
                <Input data-testid="tx-date" type="date" required {...register("date", { required: true })} />
              </Field>
              <Field label="Notes">
                <Input data-testid="tx-notes" placeholder="optional" {...register("notes")} />
              </Field>
            </div>
          </ResponsiveDialogBody>

          <ResponsiveDialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!instrumentId}>Add</Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
