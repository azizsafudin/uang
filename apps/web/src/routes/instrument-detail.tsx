import { useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import { useNavigate, useParams, Link } from "@tanstack/react-router";
import { api } from "@/lib/api";
import { instrumentsCollection, pricesCollection } from "@/lib/collections";
import { Money, formatMoney } from "@/components/money.tsx";
import { AppShell, Eyebrow } from "@/components/app-layout";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { UpdatePrice } from "@/components/update-price";
import { OwnerPills } from "@/components/owner-pills";
import { SCALE, currencyDecimals } from "@uang/shared";
import { formatDate } from "@/lib/utils";
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

const KINDS = ["currency", "stock", "etf", "fund", "crypto", "other"] as const;
const kindLabel = (k: string) => (k === "etf" ? "ETF" : k.charAt(0).toUpperCase() + k.slice(1));

type EditForm = {
  name: string;
  symbol: string;
  isin: string;
  currency: string;
  kind: (typeof KINDS)[number];
};

const S = Number(SCALE);

type Holder = { accountId: string; name: string; ownerIds: string[]; units: number; txCount: number; marketValueMinor: number; missingPrice: boolean };
type Detail = {
  instrument: { id: string; symbol: string | null; name: string; kind: string; currency: string };
  instrumentCurrency: string;
  latestPriceScaled: number | null;
  latestPriceDate: string | null;
  hasFetchedPrices: boolean;
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
  // Edit form
  const { register, handleSubmit, control, reset } = useForm<EditForm>({
    defaultValues: { name: "", symbol: "", isin: "", currency: "", kind: "stock" },
  });

  const [refreshMsg, setRefreshMsg] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  async function updatePrice() {
    setRefreshing(true);
    setRefreshMsg("Updating…");
    // Incremental: fetch only dates missing since the last stored price, up to today.
    const { data, error } = await api["market-data"].instrument({ id }).refresh.post({ backfill: true });
    if (error || !data || !("status" in data)) { setRefreshMsg("Failed"); setRefreshing(false); return; }
    if (data.status === "updated") setRefreshMsg(data.rowsWritten === 0 ? "Already up to date" : `${data.rowsWritten} new price${data.rowsWritten === 1 ? "" : "s"} · ${data.source ?? ""}`);
    else if (data.status === "unsupported") setRefreshMsg("No free source for this symbol");
    else setRefreshMsg("Failed");
    await qc.invalidateQueries({ queryKey: ["prices", id] });
    await qc.invalidateQueries({ queryKey: ["instrument", id] });
    await qc.invalidateQueries({ queryKey: ["instruments"] });
    await qc.invalidateQueries({ queryKey: ["networth"] });
    setRefreshing(false);
  }

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
    reset({
      name: instrument!.name,
      symbol: instrument!.symbol ?? "",
      isin: instrument!.isin ?? "",
      currency: instrument!.currency,
      kind: instrument!.kind as EditForm["kind"],
    });
    setEditOpen(true);
  }

  async function saveEdit(values: EditForm) {
    await instrumentsCollection.update(instrument!.id, (draft) => {
      draft.name = values.name;
      draft.symbol = values.symbol || null;
      draft.isin = values.isin || null;
      draft.currency = values.currency.toUpperCase();
      draft.kind = values.kind;
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

  // The collection holds ONLY manual prices (fetched/trade are server-managed and
  // can be a huge series). Latest effective price + the symbol/ISIN lock come from
  // GET /instruments/:id instead of deriving from a full client-side series.
  const manualPrices = [...(prices ?? [])].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const latestPriceScaled = detail?.latestPriceScaled ?? null;
  const latestPriceDate = detail?.latestPriceDate ?? null;
  const hasFetchedPrices = detail?.hasFetchedPrices ?? false;
  // priceScaled (×1e8) → currency-formatted string, e.g. "$21.34".
  const fmtPrice = (scaled: number) =>
    formatMoney(Math.round((scaled / S) * 10 ** currencyDecimals(instrument.currency)), instrument.currency);

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
                  <div className="flex min-w-0 items-center gap-2">
                    <p className="truncate font-medium">{h.name}</p>
                    <OwnerPills ownerIds={h.ownerIds} />
                  </div>
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
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <Eyebrow>Price</Eyebrow>
              {latestPriceScaled !== null ? (
                <p className="mt-1 font-medium tabular-nums" data-testid="latest-price">
                  {fmtPrice(latestPriceScaled)}
                  {latestPriceDate && (
                    <span className="text-sm font-normal text-muted-foreground"> as of {formatDate(latestPriceDate)}</span>
                  )}
                </p>
              ) : (
                <p className="mt-1 text-sm text-muted-foreground">No price yet</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              {refreshMsg && <span className="text-xs text-muted-foreground">{refreshMsg}</span>}
              <Button variant="outline" size="sm" disabled={refreshing} onClick={updatePrice} data-testid="update-price">
                {refreshing ? "Updating…" : "Update prices"}
              </Button>
              <UpdatePrice instrumentId={id} label="Add price" />
            </div>
          </div>
          {manualPrices.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-card/40 px-4 py-8 text-center text-sm text-muted-foreground">
              No manually-entered prices. Fetched prices update automatically via "Update prices".
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              {manualPrices.map((p, i) => (
                <div
                  key={p.id}
                  data-testid="price-row"
                  className={`group flex items-center justify-between gap-4 px-4 py-3 ${i > 0 ? "border-t border-border/70" : ""}`}
                >
                  <div className="min-w-0">
                    <p className="font-medium tabular-nums">{fmtPrice(p.priceScaled)}</p>
                    <p className="text-xs text-muted-foreground">{formatDate(p.date)}</p>
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
          <ResponsiveDialog
            open={deleteOpen}
            onOpenChange={(open) => { setDeleteOpen(open); if (!open) setConfirmName(""); }}
          >
            <ResponsiveDialogTrigger render={<Button variant="destructive" />}>Delete…</ResponsiveDialogTrigger>
            <ResponsiveDialogContent>
              <ResponsiveDialogHeader>
                <ResponsiveDialogTitle>Delete "{instrument.name}"?</ResponsiveDialogTitle>
              </ResponsiveDialogHeader>
              <ResponsiveDialogBody className="space-y-3 text-sm">
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
              </ResponsiveDialogBody>
              <ResponsiveDialogFooter>
                <Button type="button" variant="ghost" onClick={() => setDeleteOpen(false)}>Cancel</Button>
                <Button variant="destructive" disabled={confirmName !== instrument.name} onClick={deleteInstrument}>
                  Delete permanently
                </Button>
              </ResponsiveDialogFooter>
            </ResponsiveDialogContent>
          </ResponsiveDialog>
        </div>
      </section>

      {/* Edit dialog */}
      <ResponsiveDialog open={editOpen} onOpenChange={setEditOpen}>
        <ResponsiveDialogContent>
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>Edit instrument</ResponsiveDialogTitle>
          </ResponsiveDialogHeader>
          <form onSubmit={handleSubmit(saveEdit)} className="flex min-h-0 flex-1 flex-col">
            <ResponsiveDialogBody className="space-y-4">
              <Field label="Name">
                <Input required {...register("name", { required: true })} />
              </Field>
              <Field label="Kind">
                <Controller
                  control={control}
                  name="kind"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={(v: string | null) => v && field.onChange(v as EditForm["kind"])}>
                      <SelectTrigger className="w-full">
                        <SelectValue>{(v: unknown) => kindLabel(String(v))}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {KINDS.map((k) => (
                          <SelectItem key={k} value={k}>{kindLabel(k)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Symbol">
                  <Input disabled={hasFetchedPrices} {...register("symbol")} />
                </Field>
                <Field label="Currency">
                  <Input maxLength={3} required {...register("currency", { required: true })} />
                </Field>
              </div>
              <Field label="ISIN">
                <Input disabled={hasFetchedPrices} {...register("isin")} />
              </Field>
              {hasFetchedPrices && (
                <p className="text-xs text-muted-foreground">
                  Symbol and ISIN are locked because prices have been fetched for them. To change the security, delete this instrument (Danger zone) and re-add it.
                </p>
              )}
            </ResponsiveDialogBody>
            <ResponsiveDialogFooter>
              <Button type="button" variant="ghost" onClick={() => setEditOpen(false)}>Cancel</Button>
              <Button type="submit">Save</Button>
            </ResponsiveDialogFooter>
          </form>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </AppShell>
  );
}
