import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { instrumentKindLabel } from "@/components/labels";
import { AllocationDonut, type AllocationSlice } from "@/components/allocation-donut";

// Narrow view of the holdings response — this card only needs the allocation
// buckets. Shares the ["holdings", owner] query cache with the /assets page.
type Holdings = {
  baseCurrency: string;
  byKind: { kind: string; valueBaseMinor: number }[];
};

async function fetchHoldings(owner: string): Promise<Holdings> {
  const { data, error } = await api.holdings.get({ query: { owner } });
  if (error) throw new Error(String(error));
  return data as unknown as Holdings;
}

// The portfolio allocation breakdown (donut + legend), wrapped in a card for the
// dashboard hero. The full per-holding table lives on the /assets page.
export function PortfolioAllocationCard({ owner }: { owner: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["holdings", owner],
    queryFn: () => fetchHoldings(owner),
  });

  const base = data?.baseCurrency ?? "";
  // byKind emits "cash" for the cash bucket; instrumentKindLabel keys on "currency".
  const kindLabel = (k: string) => (k === "cash" ? "Cash" : instrumentKindLabel(k));
  const slices: AllocationSlice[] = useMemo(
    () => (data?.byKind ?? []).map((b) => ({ label: kindLabel(b.kind), valueBaseMinor: b.valueBaseMinor })),
    [data],
  );

  return (
    <div className="flex h-full flex-col rounded-2xl border border-border bg-card p-5 shadow-sm">
      <h3 className="font-heading text-lg font-semibold tracking-tight">Allocation</h3>
      <div className="flex flex-1 items-center">
        {isLoading ? (
          <div className="h-32 w-full animate-pulse rounded-xl bg-muted/40" />
        ) : slices.length === 0 ? (
          <p className="text-sm text-muted-foreground">No holdings yet.</p>
        ) : (
          <AllocationDonut slices={slices} baseCurrency={base} />
        )}
      </div>
    </div>
  );
}
