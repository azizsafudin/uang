import { CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts";
import { formatMoney } from "@/components/money";
import {
  ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig,
} from "@/components/ui/chart";

export type GoalProjectionPoint = {
  date: string;
  actual: number | null;    // realized allocated value (past + today)
  projected: number | null; // allocated + planned contribution, growing (today + future)
};

const config = {
  actual: { label: "Actual", color: "var(--chart-1)" },
  projected: { label: "Projected", color: "var(--chart-1)" },
} satisfies ChartConfig;

const LABELS: Record<string, string> = {
  actual: "Actual",
  projected: "Projected",
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
        {/* One trajectory: solid for realized past, dashed forecast for the future. */}
        <Line dataKey="actual" type="monotone" stroke="var(--color-actual)" strokeWidth={2} dot={false} connectNulls={false} />
        <Line dataKey="projected" type="monotone" stroke="var(--color-projected)" strokeWidth={2} strokeDasharray="5 3" dot={false} connectNulls={false} />
      </LineChart>
    </ChartContainer>
  );
}
