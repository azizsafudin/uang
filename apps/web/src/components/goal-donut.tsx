import { Cell, Pie, PieChart } from "recharts";
import { ChartContainer, type ChartConfig } from "@/components/ui/chart";

// Donut/breakdown slice colors, cycled per funding source. Shared so the
// detail page's source list can render matching swatches.
export const SOURCE_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];
export const UNFUNDED_COLOR = "var(--muted)";

export const sourceColor = (i: number): string => SOURCE_COLORS[i % SOURCE_COLORS.length];

export type DonutSource = { accountId: string; name: string; allocatedMinor: number };

const emptyConfig = {} satisfies ChartConfig;

// A donut whose ring is split by funding source (each its own color), plus a
// muted "unfunded" slice for the gap to target. Progress % sits in the center.
export function GoalDonut({
  sources,
  allocatedMinor,
  targetMinor,
  progressPct,
  size = 180,
}: {
  sources: DonutSource[];
  allocatedMinor: number;
  targetMinor: number;
  progressPct: number;
  size?: number;
}) {
  const unfunded = Math.max(0, targetMinor - allocatedMinor);
  const slices = [
    ...sources.map((s, i) => ({
      key: s.accountId,
      value: Math.max(0, s.allocatedMinor),
      color: sourceColor(i),
    })),
    ...(unfunded > 0 ? [{ key: "__unfunded", value: unfunded, color: UNFUNDED_COLOR }] : []),
  ];
  const outer = Math.round(size * 0.44);
  const inner = Math.round(size * 0.33);
  const big = size >= 120;

  return (
    <div className="relative mx-auto" style={{ height: size, width: size }}>
      <ChartContainer config={emptyConfig} className="h-full w-full">
        <PieChart>
          <Pie data={slices} dataKey="value" nameKey="key" innerRadius={inner} outerRadius={outer} strokeWidth={2}>
            {slices.map((s) => (
              <Cell key={s.key} fill={s.color} />
            ))}
          </Pie>
        </PieChart>
      </ChartContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center leading-none">
        <span className={big ? "font-heading text-2xl tabular-nums" : "text-xs font-medium tabular-nums"}>
          {progressPct}%
        </span>
        {big && <span className="mt-1 text-[0.65rem] uppercase tracking-wide text-muted-foreground">funded</span>}
      </div>
    </div>
  );
}
