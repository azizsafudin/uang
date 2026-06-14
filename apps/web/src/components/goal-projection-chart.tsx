import { CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts";
import { currencyDecimals } from "@uang/shared";
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

// Compact axis label from minor units, e.g. 1_050_000_00 -> "1.1M".
function compactMoney(minor: number, currency: string): string {
  const major = minor / 10 ** currencyDecimals(currency);
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(major);
}

export function GoalProjectionChart({
  series,
  targetMinor,
  targetDate,
  baseCurrency,
}: {
  series: GoalProjectionPoint[];
  targetMinor: number;
  targetDate: string | null;
  baseCurrency: string;
}) {
  return (
    <ChartContainer config={config} className="h-[280px] w-full">
      <LineChart data={series} margin={{ left: 4, right: 8, top: 16, bottom: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8}
          tickFormatter={(d: string) => String(d).slice(0, 7)} minTickGap={32} />
        <YAxis
          width={48}
          tickLine={false}
          axisLine={false}
          tickMargin={4}
          tickFormatter={(v: number) => compactMoney(v, baseCurrency)}
          // Keep the target line in view even when the projection falls short of it.
          domain={[0, (dataMax: number) => Math.max(dataMax, targetMinor)]}
        />
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
        {targetDate && <ReferenceLine x={targetDate} stroke="var(--border)" strokeDasharray="3 3" />}
        {/* One trajectory: solid for realized past, dashed forecast for the future. */}
        <Line dataKey="actual" type="monotone" stroke="var(--color-actual)" strokeWidth={2} dot={false} connectNulls={false} />
        <Line dataKey="projected" type="monotone" stroke="var(--color-projected)" strokeWidth={2} strokeDasharray="5 3" dot={false} connectNulls={false} />
      </LineChart>
    </ChartContainer>
  );
}
