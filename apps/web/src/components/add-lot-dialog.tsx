import { useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { useQueryClient } from "@tanstack/react-query";
import { SCALE, currencyDecimals } from "@uang/shared";
import { instrumentsCollection, lotsCollection } from "@/lib/collections";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const NEW = "__new__";

export function AddLotDialog({ accountId }: { accountId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data: instruments } = useLiveQuery(instrumentsCollection);
  const [instrumentId, setInstrumentId] = useState<string>(NEW);
  const [ni, setNi] = useState({ name: "", symbol: "", currency: "USD", kind: "stock" });
  const [f, setF] = useState({ units: "", unitCost: "", fees: "", tradeDate: new Date().toISOString().slice(0, 10), note: "" });
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));

  const selectedCurrency =
    instrumentId === NEW ? ni.currency : (instruments ?? []).find((i) => i.id === instrumentId)?.currency ?? "USD";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    let id = instrumentId;
    if (instrumentId === NEW) {
      const { data, error } = await api.instruments.post({
        name: ni.name,
        kind: ni.kind as any,
        currency: ni.currency.toUpperCase(),
        symbol: ni.symbol || undefined,
      });
      if (error) throw new Error(String(error));
      id = (data as any).id;
      await instrumentsCollection.utils.refetch();
    }
    const units = parseFloat(f.units);
    const unitCost = parseFloat(f.unitCost);
    const fees = parseFloat(f.fees);
    const dec = currencyDecimals(selectedCurrency.toUpperCase());
    await lotsCollection(accountId).insert({
      instrumentId: id,
      unitsScaled: Math.round(units * Number(SCALE)),
      unitCostScaled: Math.round(unitCost * Number(SCALE)),
      feesMinor: Number.isNaN(fees) ? 0 : Math.round(fees * 10 ** dec),
      tradeDate: f.tradeDate,
      note: f.note || null,
    } as any);
    await qc.invalidateQueries({ queryKey: ["holdings", accountId] });
    await qc.invalidateQueries({ queryKey: ["networth"] });
    setOpen(false);
    setF({ units: "", unitCost: "", fees: "", tradeDate: new Date().toISOString().slice(0, 10), note: "" });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>Add lot</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add lot</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <Label>Instrument</Label>
            <Select value={instrumentId} onValueChange={(v: string | null) => v && setInstrumentId(v)}>
              <SelectTrigger className="w-full">
                <SelectValue>
                  {(v: unknown) =>
                    String(v) === NEW
                      ? "New instrument…"
                      : (instruments ?? []).find((i) => i.id === String(v))?.name ?? "Select"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NEW}>New instrument…</SelectItem>
                {(instruments ?? []).map((i) => (
                  <SelectItem key={i.id} value={i.id}>
                    {i.symbol ? `${i.symbol} — ${i.name}` : i.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {instrumentId === NEW && (
            <div className="grid grid-cols-2 gap-3 rounded-lg border border-border p-3">
              <div className="col-span-2">
                <Label>Name</Label>
                <Input value={ni.name} onChange={(e) => setNi((p) => ({ ...p, name: e.target.value }))} required />
              </div>
              <div>
                <Label>Symbol</Label>
                <Input value={ni.symbol} onChange={(e) => setNi((p) => ({ ...p, symbol: e.target.value }))} placeholder="optional" />
              </div>
              <div>
                <Label>Currency</Label>
                <Input value={ni.currency} maxLength={3} onChange={(e) => setNi((p) => ({ ...p, currency: e.target.value }))} required />
              </div>
              <div className="col-span-2">
                <Label>Kind</Label>
                <Select value={ni.kind} onValueChange={(v: string | null) => v && setNi((p) => ({ ...p, kind: v }))}>
                  <SelectTrigger className="w-full">
                    <SelectValue>{(v: unknown) => String(v)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="stock">stock</SelectItem>
                    <SelectItem value="etf">etf</SelectItem>
                    <SelectItem value="fund">fund</SelectItem>
                    <SelectItem value="other">other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Units</Label>
              <Input type="number" step="any" value={f.units} onChange={(e) => set("units", e.target.value)} required />
            </div>
            <div>
              <Label>Unit cost ({selectedCurrency.toUpperCase()})</Label>
              <Input type="number" step="any" value={f.unitCost} onChange={(e) => set("unitCost", e.target.value)} required />
            </div>
            <div>
              <Label>Fees</Label>
              <Input type="number" step="any" value={f.fees} onChange={(e) => set("fees", e.target.value)} placeholder="optional" />
            </div>
            <div>
              <Label>Trade date</Label>
              <Input type="date" value={f.tradeDate} onChange={(e) => set("tradeDate", e.target.value)} required />
            </div>
          </div>

          <DialogFooter>
            <Button type="submit">Add</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
