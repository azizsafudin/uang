import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { api } from "@/lib/api";
import { currencyDecimals, currencySymbol } from "@uang/shared";
import { useMoney } from "@/lib/values-hidden";
import { Button } from "@/components/ui/button";
import { NetWorthToggle } from "@/components/net-worth-toggle";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

type SeriesPoint = { date: string; totalBaseMinor: number; netDepositsBaseMinor: number };
type Series = { baseCurrency: string; points: SeriesPoint[] };

const PRESETS = ["All", "YTD", "1M", "6M", "1Y", "3Y", "Custom"] as const;
type Preset = (typeof PRESETS)[number];

const chartConfig = {
  net: { label: "Net worth", color: "var(--chart-1)" },
  deposits: { label: "Net contributions", color: "var(--chart-2)" },
} satisfies ChartConfig;

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Coerce an axis/tooltip value (ISO day string, epoch ms, or Date) to a Date.
function asDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") return Number.isNaN(value) ? null : new Date(value);
  const d = new Date(`${String(value)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Format a day value. Defensive: never renders "Invalid Date" — falls back to
// the raw string if the value isn't a parseable date.
function formatDay(value: unknown, opts: Intl.DateTimeFormatOptions): string {
  const d = asDate(value);
  return d ? d.toLocaleDateString(undefined, opts) : String(value ?? "");
}

// Compact money label for the y-axis (e.g. "$1.2M", "€450K"). Keeps axis ticks
// short so they don't crowd the plot.
function formatMoneyCompact(minor: number, currency: string): string {
  const major = minor / 10 ** currencyDecimals(currency);
  const sign = major < 0 ? "-" : "";
  const num = new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(Math.abs(major));
  return `${sign}${currencySymbol(currency)}${num}`;
}

// Map a fixed-window preset to a {from, to} range (to = today).
function presetRange(preset: Exclude<Preset, "Custom" | "All">): { from: string; to: string } {
  const today = new Date();
  const d = new Date(today);
  switch (preset) {
    case "YTD":
      d.setMonth(0, 1);
      break;
    case "1M":
      d.setMonth(d.getMonth() - 1);
      break;
    case "6M":
      d.setMonth(d.getMonth() - 6);
      break;
    case "1Y":
      d.setFullYear(d.getFullYear() - 1);
      break;
    case "3Y":
      d.setFullYear(d.getFullYear() - 3);
      break;
  }
  return { from: iso(d), to: iso(today) };
}

async function fetchSeries(from: string | undefined, to: string, owner: string): Promise<Series> {
  // Omit `from` for "All time" — the API derives the earliest transaction date.
  const query = from ? { from, to, owner } : { to, owner };
  const { data, error } = await api.networth.series.get({ query });
  if (error) throw new Error(String(error));
  return data as unknown as Series;
}

export function NetWorthChart({
  owner,
  onOwnerChange,
}: {
  owner: string;
  onOwnerChange: (v: string) => void;
}) {
  const money = useMoney();
  const isMobile = useIsMobile();
  const [preset, setPreset] = useState<Preset>("All");
  // Custom range inputs (used only when preset === "Custom").
  const [customFrom, setCustomFrom] = useState(() => presetRange("1Y").from);
  const [customTo, setCustomTo] = useState(() => iso(new Date()));

  // `from` is undefined for "All" (the API derives the earliest tx date).
  const { from, to }: { from?: string; to: string } =
    preset === "Custom"
      ? { from: customFrom, to: customTo }
      : preset === "All"
        ? { to: iso(new Date()) }
        : presetRange(preset);

  const { data, isLoading } = useQuery({
    queryKey: ["networth-series", owner, from ?? "all", to],
    queryFn: () => fetchSeries(from, to, owner),
  });

  const base = data?.baseCurrency ?? "";
  // Plot against a numeric time axis (epoch ms) so the line keeps its true
  // horizontal spacing regardless of point density.
  const rows = (data?.points ?? []).map((p) => ({
    t: Date.parse(`${p.date}T00:00:00Z`),
    net: p.totalBaseMinor,
    deposits: p.netDepositsBaseMinor,
  }));

  // A handful of evenly-spaced ticks (first/last pinned to the data edges),
  // labelled by the month they fall in — dense data, sparse labels, like a
  // typical finance chart. Long spans show "Jun 2026"; short spans show "14 Jun".
  const minT = rows.length ? rows[0].t : 0;
  const maxT = rows.length ? rows[rows.length - 1].t : 0;
  // Narrow screens can't fit 6 "Mar 2022"-style labels without overlap, so use
  // fewer ticks and a 2-digit year ("Mar 22") on mobile.
  const TICK_COUNT = isMobile ? 4 : 6;
  const xTicks =
    rows.length > 1
      ? Array.from({ length: TICK_COUNT }, (_, i) =>
          Math.round(minT + ((maxT - minT) * i) / (TICK_COUNT - 1)),
        )
      : rows.map((r) => r.t);
  const tickDateOpts: Intl.DateTimeFormatOptions =
    maxT - minT > 90 * 86_400_000
      ? { month: "short", year: isMobile ? "2-digit" : "numeric" }
      : { day: "numeric", month: "short" };

  return (
    <section data-testid="networth-chart" className="rounded-2xl border border-border bg-card px-4 py-4 shadow-sm md:px-6 md:py-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <Button
              key={p}
              size="sm"
              variant={preset === p ? "default" : "outline"}
              onClick={() => setPreset(p)}
              className={cn(preset === p && "pointer-events-none")}
            >
              {p}
            </Button>
          ))}
        </div>
        <NetWorthToggle value={owner} onChange={onOwnerChange} />
      </div>

      {preset === "Custom" && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <input
            type="date"
            aria-label="From"
            value={customFrom}
            onChange={(e) => setCustomFrom(e.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1"
          />
          <span className="text-muted-foreground">to</span>
          <input
            type="date"
            aria-label="To"
            value={customTo}
            onChange={(e) => setCustomTo(e.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1"
          />
        </div>
      )}

      {isLoading ? (
        <div className="h-[400px] animate-pulse rounded-xl bg-muted/40" />
      ) : rows.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">No data for this range.</p>
      ) : (
        <ChartContainer config={chartConfig} className="h-[400px] w-full">
          <AreaChart data={rows} margin={{ left: 8, right: isMobile ? 16 : 8, top: 8 }}>
            <CartesianGrid vertical={false} />
            <YAxis
              dataKey="net"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              width={56}
              tickFormatter={(v) => formatMoneyCompact(Number(v), base)}
            />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={[minT, maxT]}
              ticks={xTicks}
              interval={0}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(v) => formatDay(v, tickDateOpts)}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  // The x-axis value is epoch ms (numeric), so read the date off
                  // the hovered data point rather than the tooltip's label arg
                  // (which shadcn only treats as a date when it's a string).
                  labelFormatter={(_label, payload) => {
                    const t = (payload?.[0]?.payload as { t?: number } | undefined)?.t;
                    return formatDay(t, { year: "numeric", month: "short", day: "numeric" });
                  }}
                  // Each row renders its own label + colour swatch + value (the
                  // formatter replaces the default row). Appreciation (net worth −
                  // net contributions) is appended under the last row.
                  formatter={(value, _name, item) => {
                    const p = item?.payload as { t: number; net: number; deposits: number };
                    const isDeposits = item?.dataKey === "deposits";
                    const label = isDeposits ? "Net contributions" : "Net worth";
                    const color = item?.color ?? `var(--color-${String(item?.dataKey)})`;
                    return (
                      <div className="flex flex-1 flex-col gap-1">
                        <div className="flex flex-1 items-center justify-between gap-4">
                          <span className="flex items-center gap-1.5 text-muted-foreground">
                            <span
                              className="h-2 w-2 shrink-0 rounded-[2px]"
                              style={{ backgroundColor: color }}
                            />
                            {label}
                          </span>
                          <span className="font-mono font-medium tabular-nums text-foreground">
                            {money(Number(value), base)}
                          </span>
                        </div>
                        {isDeposits && (
                          <div className="flex flex-1 items-center justify-between gap-4">
                            <span className="pl-3.5 text-muted-foreground">Appreciation</span>
                            <span className="font-mono tabular-nums text-muted-foreground">
                              {money(p.net - p.deposits, base)}
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  }}
                />
              }
            />
            {/* `net` declared first so the tooltip lists Net worth, then its
                breakdown (Net contributions + Appreciation). */}
            <Area
              dataKey="net"
              type="monotone"
              fill="var(--color-net)"
              fillOpacity={0.15}
              stroke="var(--color-net)"
              strokeWidth={2}
            />
            <Area
              dataKey="deposits"
              type="monotone"
              fill="var(--color-deposits)"
              fillOpacity={0.06}
              stroke="var(--color-deposits)"
              strokeWidth={2}
              strokeDasharray="4 3"
            />
          </AreaChart>
        </ChartContainer>
      )}
    </section>
  );
}
