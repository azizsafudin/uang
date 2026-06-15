import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import { useNavigate, useParams, Link } from "@tanstack/react-router";
import { api } from "@/lib/api";
import { instrumentsCollection, pricesCollection } from "@/lib/collections";
import { Money } from "@/components/money.tsx";
import { AppShell, Eyebrow } from "@/components/app-layout";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { UpdatePrice } from "@/components/update-price";
import { SCALE } from "@uang/shared";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";

const S = Number(SCALE);

type Holder = { accountId: string; name: string; units: number; txCount: number; marketValueMinor: number; missingPrice: boolean };
type Detail = {
  instrument: { id: string; symbol: string | null; name: string; kind: string; currency: string };
  instrumentCurrency: string;
  latestPriceScaled: number | null;
  accounts: Holder[];
  totalTx: number;
};

function useInstrumentDetail(id: string) {
  return useQuery({
    queryKey: ["instrument", id],
    queryFn: async (): Promise<Detail> => {
      const { data, error } = await api.instruments({ id }).get();
      if (error) throw new Error(String(error));
      return data as unknown as Detail;
    },
  });
}

export function InstrumentDetailPage() {
  const { id } = useParams({ from: "/app/instruments/$id" });
  const nav = useNavigate();
  const qc = useQueryClient();

  const { data: instruments, isLoading } = useLiveQuery(instrumentsCollection);
  const instrument = (instruments ?? []).find((i) => i.id === id);
  const { data: detail } = useInstrumentDetail(id);
  const { data: prices } = useLiveQuery(pricesCollection(id));

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  // Edit form state
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [isin, setIsin] = useState("");
  const [currency, setCurrency] = useState("");

  if (isLoading || !instrument) {
    return (
      <AppShell>
        <p className="text-muted-foreground">{isLoading ? "Loading…" : "Instrument not found."}</p>
      </AppShell>
    );
  }

  const isCurrency = instrument.kind === "currency";
  const holders = (detail?.accounts ?? []).filter((a) => a.units !== 0);

  function openEdit() {
    setName(instrument!.name);
    setSymbol(instrument!.symbol ?? "");
    setIsin(instrument!.isin ?? "");
    setCurrency(instrument!.currency);
    setEditOpen(true);
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    await instrumentsCollection.update(instrument!.id, (draft) => {
      draft.name = name;
      draft.symbol = symbol || null;
      draft.isin = isin || null;
      draft.currency = currency.toUpperCase();
    });
    await qc.invalidateQueries({ queryKey: ["instrument", id] });
    await qc.invalidateQueries({ queryKey: ["networth"] });
    setEditOpen(false);
  }

  async function deleteInstrument() {
    const { error } = await api.instruments({ id }).delete(undefined, { query: { confirm: "true" } });
    if (error) throw new Error(String(error));
    await qc.invalidateQueries({ queryKey: ["instruments"] });
    await qc.invalidateQueries({ queryKey: ["networth"] });
    await nav({ to: "/instruments" });
  }

  const sortedPrices = [...(prices ?? [])].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  async function delPrice(priceId: string) {
    await pricesCollection(id).delete(priceId);
    await qc.invalidateQueries({ queryKey: ["instrument", id] });
    await qc.invalidateQueries({ queryKey: ["networth"] });
  }

  return (
    <AppShell>
      <PageHeader
        eyebrow={`${isCurrency ? "Cash" : instrument.kind} · ${instrument.currency}`}
        title={`${instrument.symbol ? `${instrument.symbol} · ` : ""}${instrument.name}`}
      />
      <div className="mt-2 flex gap-2">
        <Button variant="outline" onClick={openEdit}>Edit</Button>
      </div>

      {/* Holders */}
      <section className="mt-8">
        <Eyebrow className="mb-3">Held by</Eyebrow>
        {holders.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-card/40 px-4 py-8 text-center text-sm text-muted-foreground">
            No account currently holds this instrument.
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            {holders.map((h, i) => (
              <Link
                key={h.accountId}
                to="/accounts/$id"
                params={{ id: h.accountId }}
                className={`flex items-center justify-between gap-4 px-4 py-3 hover:bg-muted/40 ${i > 0 ? "border-t border-border/70" : ""}`}
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{h.name}</p>
                  <p className="text-xs text-muted-foreground">{h.units / S} units</p>
                </div>
                <p className="shrink-0 tabular-nums font-medium">
                  {h.missingPrice ? "—" : <Money minor={h.marketValueMinor} currency={instrument.currency} />}
                </p>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Price history (hidden for currencies) */}
      {!isCurrency && (
        <section className="mt-8">
          <div className="mb-3 flex items-center justify-between">
            <Eyebrow>Price history</Eyebrow>
            <UpdatePrice instrumentId={id} label="Add price" />
          </div>
          {sortedPrices.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-card/40 px-4 py-8 text-center text-sm text-muted-foreground">
              No prices recorded yet.
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              {sortedPrices.map((p, i) => (
                <div
                  key={p.id}
                  data-testid="price-row"
                  className={`group flex items-center justify-between gap-4 px-4 py-3 ${i > 0 ? "border-t border-border/70" : ""}`}
                >
                  <div className="min-w-0">
                    <p className="font-medium tabular-nums">
                      {instrument.currency} {(p.priceScaled / S).toLocaleString(undefined, { maximumFractionDigits: 6 })}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {p.date}{p.source === "trade" ? " · from trade" : ""}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
                    onClick={() => delPrice(p.id)}
                  >
                    Delete
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Danger zone */}
      <section className="mt-10">
        <Eyebrow className="mb-3 text-destructive">Danger zone</Eyebrow>
        <div className="flex items-center justify-between rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3">
          <div>
            <p className="text-sm font-medium text-destructive">Delete instrument</p>
            <p className="text-xs text-muted-foreground">
              Removes the instrument, its prices, and all its transactions (and their cash legs). Cannot be undone.
            </p>
          </div>
          <Dialog
            open={deleteOpen}
            onOpenChange={(open) => { setDeleteOpen(open); if (!open) setConfirmName(""); }}
          >
            <DialogTrigger render={<Button variant="destructive" />}>Delete…</DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete "{instrument.name}"?</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 text-sm">
                <p className="text-muted-foreground">
                  This will delete <strong>{detail?.totalTx ?? 0}</strong> transaction(s) across these accounts:
                </p>
                <ul className="list-inside list-disc text-muted-foreground">
                  {(detail?.accounts ?? []).map((a) => (
                    <li key={a.accountId}>{a.name} — {a.txCount} txn(s)</li>
                  ))}
                  {(detail?.accounts ?? []).length === 0 && <li>No transactions reference it.</li>}
                </ul>
                <p className="text-muted-foreground">Type the instrument name to confirm.</p>
                <Input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={instrument.name} />
              </div>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setDeleteOpen(false)}>Cancel</Button>
                <Button variant="destructive" disabled={confirmName !== instrument.name} onClick={deleteInstrument}>
                  Delete permanently
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </section>

      {/* Edit dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit instrument</DialogTitle>
          </DialogHeader>
          <form onSubmit={saveEdit} className="space-y-4">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} required />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Symbol">
                <Input value={symbol} onChange={(e) => setSymbol(e.target.value)} />
              </Field>
              <Field label="Currency">
                <Input value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={3} required />
              </Field>
            </div>
            <Field label="ISIN">
              <Input value={isin} onChange={(e) => setIsin(e.target.value)} />
            </Field>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setEditOpen(false)}>Cancel</Button>
              <Button type="submit">Save</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
