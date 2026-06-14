import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { api } from "@/lib/api";
import { goalsCollection } from "@/lib/collections";
import { formatMoney } from "@/components/money";
import { formatDate } from "@/lib/utils";
import { useDestructiveAction } from "@/lib/use-destructive-action";
import { GoalForm } from "@/components/goal-form";
import { GoalDonut, sourceColor } from "@/components/goal-donut";
import { GoalProjectionChart, type GoalProjectionPoint } from "@/components/goal-projection-chart";
import { AppShell, Eyebrow } from "@/components/app-layout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";

type ProjectionResponse = {
  baseCurrency: string;
  goal: { id: string; name: string; targetDate: string | null; currency: string };
  targetMinor: number;
  allocatedMinor: number;
  progressPct: number;
  monthlyContributionMinor: number;
  requiredMonthlyMinor: number;
  projectedAtTargetMinor: number;
  onTrack: boolean;
  reachDate: string | null;
  spendType: "none" | "once" | "monthly" | "percent";
  annualIncomeMinor: number | null;
  sources: Array<{ accountId: string; name: string; allocatedMinor: number }>;
  series: GoalProjectionPoint[];
};

async function fetchProjection(id: string): Promise<ProjectionResponse> {
  const { data, error } = await api.goals({ id }).projection.get({ query: { historyMonths: 12 } });
  if (error) throw new Error(String(error));
  return data as unknown as ProjectionResponse;
}

export function GoalDetailPage() {
  const { id } = useParams({ from: "/app/goals/$id" });
  const nav = useNavigate();
  const [editOpen, setEditOpen] = useState(false);
  const { confirm, dialog } = useDestructiveAction();

  const { data: rows = [] } = useLiveQuery(goalsCollection);
  const row = rows.find((g) => g.id === id);

  const projQ = useQuery({
    queryKey: ["goals", "projection", id, row?.targetAmountMinor, row?.targetDate, row?.monthlyContributionMinor],
    queryFn: () => fetchProjection(id),
  });
  const p = projQ.data;
  const base = p?.baseCurrency ?? "";

  return (
    <AppShell
      actions={
        <Link to="/goals">
          <Button variant="ghost" size="sm">← Goals</Button>
        </Link>
      }
    >
      {!p ? (
        <div className="h-[420px] animate-pulse rounded-2xl bg-muted/40" />
      ) : (
        <>
          <div className="mb-6 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Eyebrow className="mb-2">{p.goal.targetDate ? "Goal" : "Goal · no deadline"}</Eyebrow>
              <h1 className="font-heading text-3xl tracking-tight">{p.goal.name}</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {formatMoney(p.targetMinor, base)}
                {p.goal.targetDate ? ` by ${formatDate(p.goal.targetDate)}` : " · no deadline"}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Badge variant={p.onTrack ? "default" : "destructive"}>
                {p.onTrack ? "On track" : "Behind"}
              </Badge>
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Goal actions" />}>
                  ⋮
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => setEditOpen(true)}>Edit</DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-destructive"
                    onClick={() =>
                      confirm({
                        title: "Delete goal?",
                        description: `"${p.goal.name}" will be permanently removed. This can't be undone.`,
                        onConfirm: async () => {
                          goalsCollection.delete(id);
                          await nav({ to: "/goals" });
                        },
                      })
                    }
                  >
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {row && (
                <GoalForm goal={row} defaultCurrency={base || undefined} open={editOpen} onOpenChange={setEditOpen} hideTrigger />
              )}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-[260px_1fr]">
            <section className="rounded-2xl border border-border bg-card p-4">
              <GoalDonut
                sources={p.sources}
                allocatedMinor={p.allocatedMinor}
                targetMinor={p.targetMinor}
                progressPct={p.progressPct}
              />
              <div className="mt-4 space-y-3 text-sm tabular-nums">
                <div className="space-y-1">
                  <p className="text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground">Now</p>
                  <div className="flex justify-between gap-3"><span className="shrink-0 text-muted-foreground">Allocated</span><span>{formatMoney(p.allocatedMinor, base)}</span></div>
                  <div className="flex justify-between gap-3">
                    <span className="shrink-0 text-muted-foreground">Saving</span>
                    <span>{p.monthlyContributionMinor > 0 ? `${formatMoney(p.monthlyContributionMinor, base)}/mo` : "—"}</span>
                  </div>
                </div>
                <div className="space-y-1 border-t border-border/70 pt-3">
                  <p className="text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground">Projected</p>
                  <div className="flex justify-between gap-3">
                    <span className="shrink-0 text-muted-foreground">Reaches</span>
                    <span>{p.reachDate ? formatDate(p.reachDate) : "—"}</span>
                  </div>
                  {p.goal.targetDate && p.projectedAtTargetMinor !== null && (
                    <>
                      <div className="flex justify-between gap-3">
                        <span className="shrink-0 text-muted-foreground">By {formatDate(p.goal.targetDate)}</span>
                        <span>{formatMoney(p.projectedAtTargetMinor, base)}</span>
                      </div>
                      <div className="flex justify-between gap-3">
                        <span className="shrink-0 text-muted-foreground">{p.onTrack ? "Surplus" : "Shortfall"}</span>
                        <span className={p.onTrack ? "" : "text-destructive"}>
                          {formatMoney(Math.abs(p.projectedAtTargetMinor - p.targetMinor), base)}
                        </span>
                      </div>
                    </>
                  )}
                  {p.spendType !== "none" && (
                    <div className="flex justify-between gap-3">
                      <span className="shrink-0 text-muted-foreground">
                        {p.spendType === "once" ? "Spends" : "Income"}
                      </span>
                      <span>
                        {p.spendType === "once"
                          ? `${formatMoney(p.targetMinor, base)} once${p.goal.targetDate ? ` · ${formatDate(p.goal.targetDate)}` : ""}`
                          : p.annualIncomeMinor !== null
                            ? `≈ ${formatMoney(p.annualIncomeMinor, base)}/yr`
                            : "—"}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </section>

            <section className="min-w-0 overflow-hidden rounded-2xl border border-border bg-card px-4 py-4 md:px-6 md:py-5">
              <Eyebrow className="mb-3">Projection</Eyebrow>
              <GoalProjectionChart
                series={p.series}
                targetMinor={p.targetMinor}
                targetDate={p.goal.targetDate}
                baseCurrency={base}
              />
            </section>
          </div>

          {/* Funding-source breakdown — full width below both cards. Each bar is
              the source's share of the allocated total (so they sum to 100% and
              read clearly); swatches/colors match the donut slices. */}
          <section className="mt-4 rounded-2xl border border-border bg-card p-4 md:p-6">
            <Eyebrow className="mb-4">Funding sources</Eyebrow>
            {p.sources.length === 0 ? (
              <p className="text-sm text-muted-foreground">No accounts fund this goal yet.</p>
            ) : (
              <div className="space-y-4">
                {p.sources.map((s, i) => {
                  const pct = p.allocatedMinor > 0 ? Math.round((s.allocatedMinor * 100) / p.allocatedMinor) : 0;
                  return (
                    <div key={s.accountId} className="space-y-1.5">
                      <div className="flex items-baseline gap-3">
                        <span className="h-3 w-3 shrink-0 self-center rounded-full" style={{ background: sourceColor(i) }} />
                        <span className="min-w-0 flex-1 truncate font-medium">{s.name}</span>
                        <span className="tabular-nums">{formatMoney(s.allocatedMinor, base)}</span>
                        <span className="w-12 shrink-0 text-right text-sm tabular-nums text-muted-foreground">{pct}%</span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full" style={{ width: `${Math.min(100, pct)}%`, background: sourceColor(i) }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
          {dialog}
        </>
      )}
    </AppShell>
  );
}
