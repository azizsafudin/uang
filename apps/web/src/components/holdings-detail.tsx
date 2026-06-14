import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatMoney } from "@/components/money";
import { AddLotDialog } from "@/components/add-lot-dialog";
import { UpdatePrice } from "@/components/update-price";
import { Eyebrow } from "@/components/app-layout";
import { Button } from "@/components/ui/button";
import { lotsCollection } from "@/lib/collections";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type HoldingLot = {
  lotId: string;
  instrument: { id: string; symbol: string | null; name: string; kind: string; currency: string };
  unitsScaled: number;
  unitCostScaled: number;
  feesMinor: number;
  tradeDate: string;
  priceScaled: number | null;
  mvMinor: number;
  costMinor: number;
  gainMinor: number;
  instrumentCurrency: string;
  mvBaseMinor: number;
  missingPrice: boolean;
};

type Holdings = {
  baseCurrency: string;
  totalBaseMinor: number;
  totalGainBaseMinor: number;
  missing: boolean;
  lots: HoldingLot[];
};

const SCALE = 100_000_000;
const fmtUnits = (scaled: number) => String(scaled / SCALE);

export function HoldingsDetail({ accountId, accountName }: { accountId: string; accountName: string }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["holdings", accountId],
    queryFn: async (): Promise<Holdings> => {
      const { data, error } = await api.accounts({ id: accountId }).holdings.get();
      if (error) throw new Error(String(error));
      return data as unknown as Holdings;
    },
  });

  async function delLot(lotId: string) {
    await lotsCollection(accountId).delete(lotId);
    await qc.invalidateQueries({ queryKey: ["holdings", accountId] });
    await qc.invalidateQueries({ queryKey: ["networth"] });
  }

  const base = data?.baseCurrency ?? "";
  const lots = data?.lots ?? [];

  return (
    <>
      <header>
        <Eyebrow>Investments · holdings</Eyebrow>
        <h1 className="mt-2 font-heading text-3xl tracking-tight">{accountName}</h1>
        <p className="mt-1 font-heading text-4xl tabular-nums tracking-tight">
          {isLoading || !data ? "—" : formatMoney(data.totalBaseMinor, base)}
        </p>
        {data && (
          <p className={cn("mt-1 text-sm tabular-nums", data.totalGainBaseMinor < 0 ? "text-destructive" : "text-muted-foreground")}>
            {data.totalGainBaseMinor >= 0 ? "+" : ""}
            {formatMoney(data.totalGainBaseMinor, base)} unrealized
            {data.missing && <span className="ml-2 rounded-full bg-destructive/10 px-1.5 py-0.5 text-[0.65rem] font-medium text-destructive">missing price</span>}
          </p>
        )}
      </header>

      <div className="mt-5">
        <AddLotDialog accountId={accountId} />
      </div>

      <section className="mt-9">
        <Eyebrow className="mb-3">Lots</Eyebrow>
        {lots.length === 0 ? (
          <p className="text-sm text-muted-foreground">No lots yet. Use "Add lot" to record what you hold.</p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            {lots.map((l, i) => (
              <div key={l.lotId} className={cn("group flex items-center justify-between gap-4 px-4 py-3", i > 0 && "border-t border-border/70")}>
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    {l.instrument.symbol ? `${l.instrument.symbol} · ` : ""}
                    {l.instrument.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {fmtUnits(l.unitsScaled)} units · cost {formatMoney(l.costMinor, l.instrumentCurrency)} · {l.tradeDate}
                    {l.missingPrice && <span className="ml-1.5 rounded-full bg-destructive/10 px-1.5 py-0.5 text-[0.65rem] font-medium text-destructive">no price</span>}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <div className="shrink-0 text-right tabular-nums">
                    <p className="font-medium">{l.missingPrice ? "—" : formatMoney(l.mvMinor, l.instrumentCurrency)}</p>
                    {!l.missingPrice && (
                      <p className={cn("text-xs", l.gainMinor < 0 ? "text-destructive" : "text-muted-foreground")}>
                        {l.gainMinor >= 0 ? "+" : ""}
                        {formatMoney(l.gainMinor, l.instrumentCurrency)}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    <UpdatePrice instrumentId={l.instrument.id} accountId={accountId} label="Price" />
                    <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => delLot(l.lotId)}>
                      Delete
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
