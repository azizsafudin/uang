import { useMemo, useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { useQueryClient } from "@tanstack/react-query";
import { SCALE, currencyDecimals } from "@uang/shared";
import { instrumentsCollection, transactionsCollection, newId } from "@/lib/collections";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

const S = Number(SCALE);
const NEW_CURRENCY = "__new_currency__";
const NEW_INSTRUMENT = "__new_instrument__";
const today = () => new Date().toISOString().slice(0, 10);

export function AddTransactionDialog({ accountId, accountCurrency }: { accountId: string; accountCurrency: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data: instruments } = useLiveQuery(instrumentsCollection);

  const currencies = useMemo(() => (instruments ?? []).filter((i) => i.kind === "currency"), [instruments]);
  const securities = useMemo(() => (instruments ?? []).filter((i) => i.kind !== "currency"), [instruments]);

  // Default to the account's own currency instrument if present, else "new currency".
  const [instrumentId, setInstrumentId] = useState<string>("");
  const selected = (instruments ?? []).find((i) => i.id === instrumentId);
  const isCurrencyMode = instrumentId === NEW_CURRENCY || selected?.kind === "currency";

  const [newCurrency, setNewCurrency] = useState(accountCurrency);
  const [newInstr, setNewInstr] = useState({ name: "", symbol: "", currency: accountCurrency, kind: "stock" });

  // currency-mode fields
  const [amount, setAmount] = useState("");
  // security-mode fields
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [units, setUnits] = useState("");
  const [price, setPrice] = useState("");
  const [fees, setFees] = useState("");
  const [recordCash, setRecordCash] = useState(true);
  const [cashCurrencyId, setCashCurrencyId] = useState<string>("");

  const [date, setDate] = useState(today());
  const [notes, setNotes] = useState("");

  const amountNum = parseFloat(amount);
  const securityCurrency = instrumentId === NEW_INSTRUMENT ? newInstr.currency.toUpperCase() : selected?.currency ?? accountCurrency;
  const cashAmount = (parseFloat(units) || 0) * (parseFloat(price) || 0) + (parseFloat(fees) || 0);

  function reset() {
    setInstrumentId(""); setAmount(""); setUnits(""); setPrice(""); setFees("");
    setSide("buy"); setRecordCash(true); setCashCurrencyId(""); setDate(today()); setNotes("");
    setNewInstr({ name: "", symbol: "", currency: accountCurrency, kind: "stock" });
    setNewCurrency(accountCurrency);
  }

  async function ensureCurrencyId(symbol: string): Promise<string> {
    const { data, error } = await api.instruments.currency.post({ symbol: symbol.toUpperCase() });
    if (error || !data || !("id" in data)) throw new Error(String(error ?? "currency create failed"));
    await instrumentsCollection.utils.refetch();
    return data.id;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();

    if (isCurrencyMode) {
      // Resolve the currency instrument id.
      let id = instrumentId;
      if (instrumentId === NEW_CURRENCY) id = await ensureCurrencyId(newCurrency);
      if (Number.isNaN(amountNum) || amountNum === 0) return;
      const { error } = await api.accounts({ id: accountId }).transactions.post({
        id: newId(),
        instrumentId: id,
        date,
        unitsDelta: Math.round(amountNum * S),
        unitPriceScaled: S,
        notes: notes || undefined,
      });
      if (error) throw new Error(String(error));
    } else {
      // Resolve the security instrument id.
      let id = instrumentId;
      if (instrumentId === NEW_INSTRUMENT) {
        const { data, error } = await api.instruments.post({
          name: newInstr.name,
          kind: newInstr.kind as "stock" | "etf" | "fund" | "crypto" | "other",
          currency: newInstr.currency.toUpperCase(),
          symbol: newInstr.symbol || undefined,
        });
        if (error || !data || !("id" in data)) throw new Error(String(error ?? "instrument create failed"));
        id = data.id;
        await instrumentsCollection.utils.refetch();
      }
      const u = parseFloat(units);
      const p = parseFloat(price);
      const fee = parseFloat(fees);
      if (Number.isNaN(u) || Number.isNaN(p)) return;
      const dec = currencyDecimals(securityCurrency);
      const signedUnits = side === "buy" ? u : -u;

      // Optional cash leg: a buy spends cash (negative), a sell receives cash (positive).
      let cashLeg: { instrumentId: string; unitsDelta: number } | undefined;
      if (recordCash) {
        const cashId = cashCurrencyId || (await ensureCurrencyId(securityCurrency));
        const cashUnits = side === "buy" ? -cashAmount : cashAmount;
        cashLeg = { instrumentId: cashId, unitsDelta: Math.round(cashUnits * S) };
      }

      const { error } = await api.accounts({ id: accountId }).transactions.post({
        id: newId(),
        instrumentId: id,
        date,
        unitsDelta: Math.round(signedUnits * S),
        unitPriceScaled: Math.round(p * S),
        feesMinor: Number.isNaN(fee) ? 0 : Math.round(fee * 10 ** dec),
        notes: notes || undefined,
        cashLeg,
      });
      if (error) throw new Error(String(error));
    }

    await transactionsCollection(accountId).utils.refetch();
    await qc.invalidateQueries({ queryKey: ["positions", accountId] });
    await qc.invalidateQueries({ queryKey: ["networth"] });
    setOpen(false);
    reset();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
      <DialogTrigger render={<Button />}>Add transaction</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add transaction</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Instrument">
            <Select value={instrumentId} onValueChange={(v: string | null) => v && setInstrumentId(v)}>
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
          </Field>

          {instrumentId === NEW_CURRENCY && (
            <Field label="Currency code">
              <Input data-testid="tx-new-currency" value={newCurrency} maxLength={3}
                     onChange={(e) => setNewCurrency(e.target.value)} required />
            </Field>
          )}

          {instrumentId === NEW_INSTRUMENT && (
            <div className="grid grid-cols-2 gap-4 rounded-lg border border-border p-3">
              <Field label="Name" className="col-span-2">
                <Input data-testid="tx-instr-name" value={newInstr.name}
                       onChange={(e) => setNewInstr((p) => ({ ...p, name: e.target.value }))} required />
              </Field>
              <Field label="Symbol">
                <Input data-testid="tx-instr-symbol" value={newInstr.symbol}
                       onChange={(e) => setNewInstr((p) => ({ ...p, symbol: e.target.value }))} placeholder="optional" />
              </Field>
              <Field label="Currency">
                <Input data-testid="tx-instr-currency" value={newInstr.currency} maxLength={3}
                       onChange={(e) => setNewInstr((p) => ({ ...p, currency: e.target.value }))} required />
              </Field>
              <Field label="Kind" className="col-span-2">
                <Select value={newInstr.kind} onValueChange={(v: string | null) => v && setNewInstr((p) => ({ ...p, kind: v }))}>
                  <SelectTrigger className="w-full"><SelectValue>{(v: unknown) => String(v)}</SelectValue></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="stock">stock</SelectItem>
                    <SelectItem value="etf">etf</SelectItem>
                    <SelectItem value="fund">fund</SelectItem>
                    <SelectItem value="crypto">crypto</SelectItem>
                    <SelectItem value="other">other</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>
          )}

          {instrumentId === "" ? (
            <p className="text-sm text-muted-foreground">
              Pick an instrument above — cash to record a deposit or withdrawal, or a security to buy or sell.
            </p>
          ) : isCurrencyMode ? (
            <Field label="Amount (+ add, − subtract)">
              <Input data-testid="tx-amount" type="number" step="any" value={amount}
                     onChange={(e) => setAmount(e.target.value)}
                     className={cn("tabular-nums", !Number.isNaN(amountNum) && (amountNum < 0 ? "text-destructive" : "text-emerald-600"))}
                     required />
            </Field>
          ) : (
            <>
              <Field label="Side">
                <Select value={side} onValueChange={(v: string | null) => v && setSide(v as "buy" | "sell")}>
                  <SelectTrigger className="w-full" data-testid="tx-side"><SelectValue>{(v: unknown) => String(v) === "sell" ? "Sell" : "Buy"}</SelectValue></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="buy">Buy</SelectItem>
                    <SelectItem value="sell">Sell</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Units">
                  <Input data-testid="tx-units" type="number" step="any" value={units} onChange={(e) => setUnits(e.target.value)} required />
                </Field>
                <Field label={`Price (${securityCurrency})`}>
                  <Input data-testid="tx-price" type="number" step="any" value={price} onChange={(e) => setPrice(e.target.value)} required />
                </Field>
                <Field label="Fees">
                  <Input data-testid="tx-fees" type="number" step="any" value={fees} onChange={(e) => setFees(e.target.value)} placeholder="optional" />
                </Field>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={recordCash} onChange={(e) => setRecordCash(e.target.checked)} data-testid="tx-record-cash" />
                Also record cash {side === "buy" ? "outflow" : "inflow"} ({side === "buy" ? "−" : "+"}{cashAmount.toFixed(2)} {securityCurrency})
              </label>
              {recordCash && currencies.length > 0 && (
                <Field label="Cash from">
                  <Select value={cashCurrencyId} onValueChange={(v: string | null) => v && setCashCurrencyId(v)}>
                    <SelectTrigger className="w-full"><SelectValue>{(v: unknown) => {
                      const i = currencies.find((c) => c.id === String(v));
                      return i ? `${i.symbol} — ${i.name}` : `${securityCurrency} (auto)`;
                    }}</SelectValue></SelectTrigger>
                    <SelectContent>
                      {currencies.map((i) => (<SelectItem key={i.id} value={i.id}>{i.symbol} — {i.name}</SelectItem>))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
            </>
          )}

          <div className="grid grid-cols-2 gap-4">
            <Field label="Date">
              <Input data-testid="tx-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
            </Field>
            <Field label="Notes">
              <Input data-testid="tx-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" />
            </Field>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!instrumentId}>Add</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
