import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts";
import { projectNetWorth, milestoneYears, deriveAccountFlows, type ProjectionAccount, type GoalFlowInput } from "@uang/shared";
import { api } from "@/lib/api";
import { useMoney } from "@/lib/values-hidden";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

type GoalAnalysisRow = {
  id: string;
  targetDate: string | null;
  reachDate: string | null;
  monthlyContributionMinor: number;
  contributionAccountId: string | null;
  accountIds: string[];
  spendType: "none" | "once" | "monthly" | "percent";
  spendAmountMinor: number | null;
  spendRateBps: number | null;
};
type GoalAnalysisResponse = { goals: GoalAnalysisRow[] };

type NwAccount = {
  id: string;
  class: "asset" | "liability";
  baseMinor: number;
  ownerIds: string[];
  growthRateBps: number;
  accessibleFromAge: number;
  earlyWithdrawal: "none" | "penalty";
  earlyHaircutBps: number;
  illiquid: boolean;
  liquidationAge: number | null;
  compoundInterval: "monthly" | "quarterly" | "annually";
  loanTermMonths: number | null;
};
type NwResponse = { baseCurrency: string; accounts: NwAccount[] };
type Member = { id: string; name: string; birthYear: number | null };

const chartConfig = {
  total: { label: "Total", color: "var(--chart-1)" },
  accessible: { label: "Accessible", color: "var(--chart-2)" },
} satisfies ChartConfig;

async function fetchNetWorth(): Promise<NwResponse> {
  const { data, error } = await api.networth.get({ query: { owner: "household" } });
  if (error) throw new Error(String(error));
  return data as unknown as NwResponse;
}

async function fetchMembers(): Promise<Member[]> {
  const { data, error } = await api.members.get();
  if (error) throw new Error(String(error));
  return (data as unknown as Member[]) ?? [];
}

async function fetchGoalAnalysis(): Promise<GoalAnalysisResponse> {
  const { data, error } = await api.goals.analysis.get();
  if (error) throw new Error(String(error));
  return data as unknown as GoalAnalysisResponse;
}

const MILESTONE_COLORS = ["var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

// Custom ReferenceLine label. Recharts injects `viewBox` (the line's rect: for a
// vertical line, x is the line's pixel-x, y is the plot top, height is the plot
// height). We draw the label *inside* the top of the plot and push each member
// onto its own row so names at nearby milestone years don't collide or clip.
function MilestoneLabel({
  viewBox,
  name,
  age,
  color,
  row,
}: {
  viewBox?: { x?: number; y?: number; width?: number; height?: number };
  name: string;
  age: number;
  color: string;
  row: number;
}) {
  const x = viewBox?.x ?? 0;
  const y = (viewBox?.y ?? 0) + 11 + row * 13;
  return (
    <text x={x} y={y} fill={color} fontSize={10} textAnchor="middle">
      {name} {age}
    </text>
  );
}

export function ProjectionChart() {
  const money = useMoney();
  const [endAge, setEndAge] = useState(90);
  const nwQ = useQuery({ queryKey: ["networth", "household"], queryFn: fetchNetWorth });
  const membersQ = useQuery({ queryKey: ["members"], queryFn: fetchMembers });
  const goalsQ = useQuery({ queryKey: ["goals", "analysis"], queryFn: fetchGoalAnalysis });

  const base = nwQ.data?.baseCurrency ?? "";
  const thisYear = new Date().getFullYear();

  const { rows, milestones } = useMemo(() => {
    const accounts = nwQ.data?.accounts ?? [];
    const members = membersQ.data ?? [];
    const birthById = new Map(members.map((m) => [m.id, m.birthYear]));

    const yearOf = (iso: string | null): number | null => (iso ? parseInt(iso.slice(0, 10), 10) : null);
    const goalRows = goalsQ.data?.goals ?? [];
    const goalFlows: GoalFlowInput[] = goalRows.map((g) => {
      const targetYear = yearOf(g.targetDate);
      const routeAccountId = g.contributionAccountId ?? g.accountIds[0] ?? null;
      return {
        monthlyContributionMinor: g.monthlyContributionMinor,
        contributionAccountId: routeAccountId,
        contributionUntilYear: targetYear ?? yearOf(g.reachDate),
        spendType: g.spendType,
        spendAmountMinor: g.spendAmountMinor ?? null,
        spendRateBps: g.spendRateBps ?? null,
        payoutStartYear: targetYear,
        payoutAccountId: routeAccountId,
      };
    });
    const flows = deriveAccountFlows(goalFlows);

    const projAccounts: ProjectionAccount[] = accounts.map((a) => ({
      baseMinor: a.baseMinor,
      growthRateBps: a.growthRateBps,
      accessibleFromAge: a.accessibleFromAge,
      earlyWithdrawal: a.earlyWithdrawal,
      earlyHaircutBps: a.earlyHaircutBps,
      illiquid: a.illiquid,
      liquidationAge: a.liquidationAge,
      ownerBirthYears: a.ownerIds.map((id) => birthById.get(id) ?? null).filter((y): y is number => y != null),
      compoundInterval: a.compoundInterval,
      isLiability: a.class === "liability",
      loanTermMonths: a.loanTermMonths,
      contributions: flows.get(a.id)?.contributions ?? [],
      payouts: flows.get(a.id)?.payouts ?? [],
    }));

    const birthYears = members.map((m) => m.birthYear).filter((y): y is number => y != null);
    const youngestBirth = birthYears.length ? Math.max(...birthYears) : null;
    const toYear = youngestBirth ? youngestBirth + endAge : thisYear + 50;

    const points = projectNetWorth({
      accounts: projAccounts,
      fromYear: thisYear,
      toYear: Math.max(toYear, thisYear),
    });
    const rows = points.map((p) => ({
      year: p.year,
      total: p.totalBaseMinor,
      accessible: p.accessibleBaseMinor,
    }));

    const milestones = members
      .filter((m) => m.birthYear != null)
      .flatMap((m, memberIdx) =>
        milestoneYears(m.birthYear as number)
          .filter((ms) => ms.year >= thisYear && ms.year <= (rows.at(-1)?.year ?? thisYear))
          .map((ms) => ({
            ...ms,
            name: m.name,
            row: memberIdx,
            color: MILESTONE_COLORS[memberIdx % MILESTONE_COLORS.length],
          })),
      );

    return { rows, milestones };
  }, [nwQ.data, membersQ.data, goalsQ.data, endAge, thisYear]);

  return (
    <section data-testid="projection-chart" className="rounded-2xl border border-border bg-card px-4 py-4 shadow-sm md:px-6 md:py-5">
      <div className="mb-3 flex items-center gap-2">
        <Label htmlFor="endAge" className="text-sm text-muted-foreground">
          Project until age
        </Label>
        <Input
          id="endAge"
          type="number"
          className="w-20"
          min={1}
          value={endAge}
          onChange={(e) => setEndAge(Math.max(1, parseInt(e.target.value, 10) || 90))}
        />
      </div>

      {nwQ.isLoading || membersQ.isLoading || goalsQ.isLoading ? (
        <div className="h-[260px] animate-pulse rounded-xl bg-muted/40" />
      ) : rows.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">No accounts to project.</p>
      ) : (
        <ChartContainer config={chartConfig} className="h-[260px] w-full">
          <LineChart data={rows} margin={{ left: 8, right: 8, top: 16 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="year" tickLine={false} axisLine={false} tickMargin={8} />
            <YAxis hide />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(l) => `Year ${l}`}
                  formatter={(value, name) =>
                    `${name === "total" ? "Total" : "Accessible"}: ${money(Number(value), base)}`
                  }
                />
              }
            />
            {milestones.map((ms) => (
              <ReferenceLine
                key={`${ms.name}-${ms.age}`}
                x={ms.year}
                stroke={ms.color}
                strokeDasharray="3 3"
                label={
                  <MilestoneLabel
                    name={ms.name}
                    age={ms.age}
                    color={ms.color}
                    row={ms.row}
                  />
                }
              />
            ))}
            <Line
              dataKey="total"
              type="monotone"
              stroke="var(--color-total)"
              strokeWidth={2}
              dot={false}
            />
            <Line
              dataKey="accessible"
              type="monotone"
              stroke="var(--color-accessible)"
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ChartContainer>
      )}
    </section>
  );
}
