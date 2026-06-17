import { Cell, Pie, PieChart } from "recharts";
import { ChartContainer, type ChartConfig } from "@/components/ui/chart";
import { Money } from "@/components/money.tsx";

const SLICE_COLORS = [
  "var(--chart-1)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-2)",
  "var(--chart-5)",
];
export const sliceColor = (i: number): string => SLICE_COLORS[i % SLICE_COLORS.length];

const emptyConfig = {} satisfies ChartConfig;

export type AllocationSlice = { label: string; valueBaseMinor: number };

// A donut split by allocation bucket, with a legend listing each bucket's value
// and % of total. Buckets arrive pre-sorted (largest first) from the caller.
export function AllocationDonut({
  slices,
  baseCurrency,
  size = 132,
}: {
  slices: AllocationSlice[];
  baseCurrency: string;
  size?: number;
}) {
  const total = slices.reduce((sum, s) => sum + Math.max(0, s.valueBaseMinor), 0);
  const data = slices
    .filter((s) => s.valueBaseMinor > 0)
    .map((s, i) => ({ key: s.label, value: s.valueBaseMinor, color: sliceColor(i) }));

  if (data.length === 0) {
    return <p className="text-sm text-muted-foreground">No allocation to show.</p>;
  }

  const outer = Math.round(size * 0.46);
  const inner = Math.round(size * 0.31);

  return (
    <div className="flex flex-wrap items-center gap-5">
      <div style={{ height: size, width: size }} className="shrink-0">
        <ChartContainer config={emptyConfig} className="h-full w-full">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="key" innerRadius={inner} outerRadius={outer} strokeWidth={2}>
              {data.map((d) => (
                <Cell key={d.key} fill={d.color} />
              ))}
            </Pie>
          </PieChart>
        </ChartContainer>
      </div>
      <ul className="flex min-w-0 flex-col gap-2 text-sm">
        {data.map((d) => {
          const pct = total > 0 ? Math.round((d.value / total) * 100) : 0;
          return (
            <li key={d.key} className="flex items-center gap-2">
              <span className="size-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: d.color }} />
              <span className="truncate">{d.key}</span>
              <span className="ml-auto whitespace-nowrap tabular-nums text-muted-foreground">
                <Money minor={d.value} currency={baseCurrency} /> · {pct}%
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
