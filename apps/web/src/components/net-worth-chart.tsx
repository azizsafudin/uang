import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts";
import { api } from "@/lib/api";
import { formatMoney } from "@/components/money";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

type SeriesPoint = { date: string; totalBaseMinor: number };
type Series = { baseCurrency: string; points: SeriesPoint[] };

const PRESETS = ["YTD", "1M", "6M", "1Y", "3Y", "Custom"] as const;
type Preset = (typeof PRESETS)[number];

const chartConfig = {
  net: { label: "Net worth", color: "var(--chart-1)" },
} satisfies ChartConfig;

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Map a non-custom preset to a {from, to} range (to = today).
function presetRange(preset: Exclude<Preset, "Custom">): { from: string; to: string } {
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

async function fetchSeries(from: string, to: string, owner: string): Promise<Series> {
  const { data, error } = await api.networth.series.get({ query: { from, to, owner } });
  if (error) throw new Error(String(error));
  return data as unknown as Series;
}

export function NetWorthChart({ owner }: { owner: string }) {
  const [preset, setPreset] = useState<Preset>("1Y");
  // Custom range inputs (used only when preset === "Custom").
  const [customFrom, setCustomFrom] = useState(() => presetRange("1Y").from);
  const [customTo, setCustomTo] = useState(() => iso(new Date()));

  const { from, to } =
    preset === "Custom" ? { from: customFrom, to: customTo } : presetRange(preset);

  const { data, isLoading } = useQuery({
    queryKey: ["networth-series", owner, from, to],
    queryFn: () => fetchSeries(from, to, owner),
  });

  const base = data?.baseCurrency ?? "";
  const rows = (data?.points ?? []).map((p) => ({ date: p.date, net: p.totalBaseMinor }));

  return (
    <section className="rounded-2xl border border-border bg-card px-4 py-4 shadow-sm md:px-6 md:py-5">
      <div className="mb-3 flex flex-wrap gap-1.5">
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
        <div className="h-[200px] animate-pulse rounded-xl bg-muted/40" />
      ) : rows.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">No data for this range.</p>
      ) : (
        <ChartContainer config={chartConfig} className="h-[200px] w-full">
          <AreaChart data={rows} margin={{ left: 8, right: 8, top: 8 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={32}
              tickFormatter={(v: string) =>
                new Date(`${v}T00:00:00Z`).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })
              }
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(label) =>
                    new Date(`${String(label)}T00:00:00Z`).toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })
                  }
                  formatter={(value) => formatMoney(Number(value), base)}
                />
              }
            />
            <Area
              dataKey="net"
              type="monotone"
              fill="var(--color-net)"
              fillOpacity={0.15}
              stroke="var(--color-net)"
              strokeWidth={2}
            />
          </AreaChart>
        </ChartContainer>
      )}
    </section>
  );
}
