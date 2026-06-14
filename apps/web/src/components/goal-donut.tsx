import { Cell, Pie, PieChart } from "recharts";
import { ChartContainer, type ChartConfig } from "@/components/ui/chart";

const config = {
  allocated: { label: "Allocated", color: "var(--chart-1)" },
  remaining: { label: "Remaining", color: "var(--muted)" },
} satisfies ChartConfig;

export function GoalDonut({
  allocatedMinor,
  targetMinor,
  progressPct,
}: {
  allocatedMinor: number;
  targetMinor: number;
  progressPct: number;
}) {
  const remaining = Math.max(0, targetMinor - allocatedMinor);
  const data = [
    { key: "allocated", value: Math.max(0, allocatedMinor) },
    { key: "remaining", value: remaining },
  ];
  return (
    <div className="relative">
      <ChartContainer config={config} className="mx-auto aspect-square h-[180px]">
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="key" innerRadius={60} outerRadius={80} strokeWidth={2}>
            {data.map((d) => (
              <Cell key={d.key} fill={`var(--color-${d.key})`} />
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
