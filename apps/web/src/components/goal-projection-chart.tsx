import { CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts";
import { formatMoney } from "@/components/money";
import {
  ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig,
} from "@/components/ui/chart";

export type GoalProjectionPoint = {
  date: string;
  actual: number | null;
  onPlan: number | null;
  eligible: number | null;
};

const config = {
  actual: { label: "Actual", color: "var(--chart-1)" },
  onPlan: { label: "On plan", color: "var(--chart-2)" },
  eligible: { label: "Eligible (no new saving)", color: "var(--chart-4)" },
} satisfies ChartConfig;

const LABELS: Record<string, string> = {
  actual: "Actual",
  onPlan: "On plan",
  eligible: "Eligible (no new saving)",
};

export function GoalProjectionChart({
  series,
  targetMinor,
  targetDate,
  baseCurrency,
}: {
  series: GoalProjectionPoint[];
  targetMinor: number;
  targetDate: string;
  baseCurrency: string;
}) {
  // The "no new saving" line only carries information when the funding accounts
  // actually grow. With all-0% growth it's a flat duplicate of today's allocation,
  // so hide it (it reappears, curving, once an account has a growth rate).
  const eligibleVals = series.map((p) => p.eligible).filter((v): v is number => v != null);
  const showEligible = eligibleVals.length > 1 && Math.max(...eligibleVals) !== Math.min(...eligibleVals);

  return (
    <ChartContainer config={config} className="h-[280px] w-full">
      <LineChart data={series} margin={{ left: 8, right: 8, top: 16, bottom: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8}
          tickFormatter={(d: string) => String(d).slice(0, 7)} minTickGap={32} />
        <YAxis hide />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(l) => String(l)}
              formatter={(value, name) => `${LABELS[String(name)] ?? String(name)}: ${formatMoney(Number(value), baseCurrency)}`}
            />
          }
        />
        <ReferenceLine y={targetMinor} stroke="var(--chart-3)" strokeDasharray="4 4"
          label={{ value: "Target", position: "insideTopRight", fontSize: 10 }} />
        <ReferenceLine x={targetDate} stroke="var(--border)" strokeDasharray="3 3" />
        <Line dataKey="actual" type="monotone" stroke="var(--color-actual)" strokeWidth={2} dot={false} connectNulls={false} />
        <Line dataKey="onPlan" type="monotone" stroke="var(--color-onPlan)" strokeWidth={2} strokeDasharray="5 3" dot={false} connectNulls={false} />
        {showEligible && (
          <Line dataKey="eligible" type="monotone" stroke="var(--color-eligible)" strokeWidth={2} dot={false} connectNulls={false} />
        )}
      </LineChart>
    </ChartContainer>
  );
}
