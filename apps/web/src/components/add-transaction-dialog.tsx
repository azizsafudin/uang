import { useEffect, useMemo, useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { useLiveQuery } from "@tanstack/react-db";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SCALE, currencyDecimals } from "@uang/shared";
import { accountsCollection, instrumentsCollection, transactionsCollection, newId } from "@/lib/collections";
import { api } from "@/lib/api";
import { resolveDefaultAccountId } from "@/lib/last-used-account";
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
import { NewInstrumentForm, type NewInstrumentSpec } from "@/components/new-instrument-form";

const S = Number(SCALE);
const NEW_CURRENCY = "__new_currency__";
const NEW_INSTRUMENT = "__new_instrument__";
const today = () => new Date().toISOString().slice(0, 10);

type FormValues = {
  instrumentId: string;
  newCurrency: string;
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

type AddTransactionDialogProps = {
  // When omitted, the dialog runs in "global" mode: it shows an account picker
  // (pre-filled to the last-used account) and expects controlled open state.
  accountId?: string;
  accountCurrency?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  showTrigger?: boolean;
};

export function AddTransactionDialog({
  accountId,
  accountCurrency,
  open,
  onOpenChange,
  showTrigger = true,
}: AddTransactionDialogProps) {
  const qc = useQueryClient();
  const globalMode = accountId === undefined;

  // Open state: controlled by the parent when `open` is provided, else internal.
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = open !== undefined;
  const dialogOpen = isControlled ? open : internalOpen;

  const [splitApplied, setSplitApplied] = useState(false);
  const [newSpec, setNewSpec] = useState<NewInstrumentSpec | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const { data: instruments } = useLiveQuery(instrumentsCollection);
  const { data: accounts } = useLiveQuery(accountsCollection);

  // Global mode needs the all-accounts feed to pick the last-used account.
  const { data: allTx } = useQuery({
    queryKey: ["transactions", "all"],
    queryFn: async () => {
      const { data, error } = await api.transactions.get();
      if (error) throw new Error(String(error));
      return Array.isArray(data) ? data : [];
    },
    enabled: globalMode,
  });

  const effectiveAccountId = accountId ?? selectedAccountId;
  const effectiveAccountCurrency =
    accountCurrency ?? (accounts ?? []).find((a) => a.id === effectiveAccountId)?.currency ?? "";

  // Pre-select the last-used account the first time global mode has data.
  useEffect(() => {
    if (!globalMode || selectedAccountId) return;
    const def = resolveDefaultAccountId(allTx, accounts);
    if (def) setSelectedAccountId(def);
  }, [globalMode, selectedAccountId, allTx, accounts]);

  const currencies = useMemo(() => (instruments ?? []).filter((i) => i.kind === "currency"), [instruments]);
  const securities = useMemo(() => (instruments ?? []).filter((i) => i.kind !== "currency"), [instruments]);

  const defaults = (): FormValues => ({
    instrumentId: "",
    newCurrency: effectiveAccountCurrency,
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
    setNewSpec(null);
  }

  function setDialogOpen(v: boolean) {
    if (isControlled) onOpenChange?.(v);
    else setInternalOpen(v);
  }

  // Reactive reads driving conditional fields and derived hints.
  const instrumentId = watch("instrumentId");
  const amount = watch("amount");
  const units = watch("units");
  const price = watch("price");
  const fees = watch("fees");
  const side = watch("side");
  const recordCash = watch("recordCash");

  const selected = (instruments ?? []).find((i) => i.id === instrumentId);
  const isCurrencyMode = instrumentId === NEW_CURRENCY || selected?.kind === "currency";
  const currencyModeCurrency =
    instrumentId === NEW_CURRENCY ? watch("newCurrency").toUpperCase() : selected?.currency ?? effectiveAccountCurrency;

  const amountNum = parseFloat(amount);

  // Loan-payment helper: on a liability with an interest rate, a positive cash
  // payment is part interest, part principal. Only the principal pays down the
  // balance, so we suggest the principal amount and prefill the interest in the
  // note. One month of interest on the outstanding balance (matches projections).
  const acctRow = (accounts ?? []).find((a) => a.id === effectiveAccountId);
  const dec = currencyDecimals(effectiveAccountCurrency || "USD");
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
    setValue("notes", `Interest: ${monthlyInterestMajor.toFixed(dec)} ${effectiveAccountCurrency} (${loanRateBps / 100}%/yr)`);
    setSplitApplied(true);
  }

  const securityCurrency =
    instrumentId === NEW_INSTRUMENT ? (newSpec?.currency ?? effectiveAccountCurrency) : selected?.currency ?? effectiveAccountCurrency;
  const cashAmount = (parseFloat(units) || 0) * (parseFloat(price) || 0) + (parseFloat(fees) || 0);

  async function ensureCurrencyId(symbol: string): Promise<string> {
    const { data, error } = await api.instruments.currency.post({ symbol: symbol.toUpperCase() });
    if (error || !data || !("id" in data)) throw new Error(String(error ?? "currency create failed"));
    await instrumentsCollection.utils.refetch();
    return data.id;
  }

  async function onSubmit(values: FormValues) {
    if (!effectiveAccountId) return;
    const sel = (instruments ?? []).find((i) => i.id === values.instrumentId);
    const isCash = values.instrumentId === NEW_CURRENCY || sel?.kind === "currency";

    if (isCash) {
      // Resolve the currency instrument id.
      let id = values.instrumentId;
      if (values.instrumentId === NEW_CURRENCY) id = await ensureCurrencyId(values.newCurrency);
      const amt = parseFloat(values.amount);
      if (Number.isNaN(amt) || amt === 0) return;
      const { error } = await api.accounts({ id: effectiveAccountId }).transactions.post({
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
        if (!newSpec) return;
        const { data, error } = await api.instruments.post({
          name: newSpec.name,
          kind: newSpec.kind,
          currency: newSpec.currency,
          symbol: newSpec.symbol ?? undefined,
          isin: newSpec.isin ?? undefined,
        });
        if (error || !data || !("id" in data) || !data.id) throw new Error(String(error ?? "instrument create failed"));
        id = data.id;
        await instrumentsCollection.utils.refetch();
        if (newSpec.symbol || newSpec.isin) {
          await api["market-data"].instrument({ id: data.id }).refresh.post({ backfill: true });
        }
      }
      const u = parseFloat(values.units);
      const p = parseFloat(values.price);
      const fee = parseFloat(values.fees);
      if (Number.isNaN(u) || Number.isNaN(p)) return;
      const secCurrency =
        values.instrumentId === NEW_INSTRUMENT ? newSpec!.currency : sel?.currency ?? effectiveAccountCurrency;
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

      const { error } = await api.accounts({ id: effectiveAccountId }).transactions.post({
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

    await transactionsCollection(effectiveAccountId).utils.refetch();
    await qc.invalidateQueries({ queryKey: ["positions", effectiveAccountId] });
    await qc.invalidateQueries({ queryKey: ["networth"] });
    await qc.invalidateQueries({ queryKey: ["holdings"] });
    await qc.invalidateQueries({ queryKey: ["transactions", "all"] });
    setDialogOpen(false);
    resetForm();
  }

  return (
    <ResponsiveDialog open={dialogOpen} onOpenChange={(v) => { setDialogOpen(v); if (!v) resetForm(); }}>
      {showTrigger ? (
        <ResponsiveDialogTrigger render={<Button />}>Add transaction</ResponsiveDialogTrigger>
      ) : null}
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Add transaction</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="flex min-h-0 flex-1 flex-col">
          <ResponsiveDialogBody className="space-y-4">
            {globalMode ? (
              <Field label="Account">
                <Select value={selectedAccountId} onValueChange={(v: string | null) => v && setSelectedAccountId(v)}>
                  <SelectTrigger className="w-full" data-testid="tx-account">
                    <SelectValue>
                      {(v: unknown) => {
                        const a = (accounts ?? []).find((x) => x.id === String(v));
                        return a ? a.name : "Select account";
                      }}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {(accounts ?? []).map((a) => (
                      <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : null}

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
              <NewInstrumentForm defaultCurrency={effectiveAccountCurrency} onResolved={setNewSpec} />
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
                      Loan payment: ~{monthlyInterestMajor.toFixed(dec)} {effectiveAccountCurrency} interest this month ·{" "}
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
            ) : instrumentId === NEW_INSTRUMENT && !newSpec ? (
              <p className="text-sm text-muted-foreground">
                Look up a symbol or ISIN above (or add one manually) to continue.
              </p>
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
            <Button type="button" variant="ghost" onClick={() => { setDialogOpen(false); resetForm(); }}>
              Cancel
            </Button>
            <Button type="submit" disabled={!instrumentId || (globalMode && !selectedAccountId) || (instrumentId === NEW_INSTRUMENT && !newSpec)}>Add</Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
