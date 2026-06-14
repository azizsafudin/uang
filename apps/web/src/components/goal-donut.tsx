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
}: {
  sources: DonutSource[];
  allocatedMinor: number;
  targetMinor: number;
  progressPct: number;
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

  return (
    <div className="relative">
      <ChartContainer config={emptyConfig} className="mx-auto aspect-square h-[180px]">
        <PieChart>
          <Pie data={slices} dataKey="value" nameKey="key" innerRadius={60} outerRadius={80} strokeWidth={2}>
            {slices.map((s) => (
              <Cell key={s.key} fill={s.color} />
            ))}
          </Pie>
        </PieChart>
      </ChartContainer>
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <span className="font-heading text-2xl tabular-nums">{progressPct}%</span>
      </div>
    </div>
  );
}
