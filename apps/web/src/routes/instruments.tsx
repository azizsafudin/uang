import { Link } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { AppShell } from "@/components/app-layout";
import { PageHeader } from "@/components/page-header";
import { instrumentsCollection } from "@/lib/collections";
import { SCALE } from "@uang/shared";

const S = Number(SCALE);

function priceLabel(kind: string, scaled: number | null, currency: string): string {
  if (kind === "currency") return "1.00 (implicit)";
  if (scaled === null) return "—";
  return `${currency} ${(scaled / S).toLocaleString(undefined, { maximumFractionDigits: 6 })}`;
}

export function InstrumentsPage() {
  const { data: instruments, isLoading } = useLiveQuery(instrumentsCollection);
  const rows = [...(instruments ?? [])].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <AppShell>
      <PageHeader eyebrow="Holdings" title="Instruments" />
      {isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card/40 px-4 py-10 text-center text-sm text-muted-foreground">
          No instruments yet. They are created when you log a transaction.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {rows.map((i, idx) => (
            <Link
              key={i.id}
              to="/instruments/$id"
              params={{ id: i.id }}
              data-testid="instrument-row"
              className={`flex items-center justify-between gap-4 px-4 py-3 hover:bg-muted/40 ${idx > 0 ? "border-t border-border/70" : ""}`}
            >
              <div className="min-w-0">
                <p className="truncate font-medium">
                  {i.symbol ? `${i.symbol} · ` : ""}{i.name}
                  <span className="ml-2 rounded-full bg-muted px-1.5 py-0.5 text-[0.65rem] font-medium text-muted-foreground">
                    {i.kind === "currency" ? "cash" : i.kind}
                  </span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {i.currency} · {i.holderCount} {i.holderCount === 1 ? "account" : "accounts"}
                </p>
              </div>
              <div className="shrink-0 text-right tabular-nums text-sm">
                <p className="font-medium">{priceLabel(i.kind, i.latestPriceScaled, i.currency)}</p>
                {i.latestPriceDate && <p className="text-xs text-muted-foreground">{i.latestPriceDate}</p>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </AppShell>
  );
}
