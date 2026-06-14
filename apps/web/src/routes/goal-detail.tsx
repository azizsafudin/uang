import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { api } from "@/lib/api";
import { goalsCollection } from "@/lib/collections";
import { formatMoney } from "@/components/money";
import { GoalForm } from "@/components/goal-form";
import { GoalDonut } from "@/components/goal-donut";
import { GoalProjectionChart, type GoalProjectionPoint } from "@/components/goal-projection-chart";
import { AppShell, Eyebrow } from "@/components/app-layout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";

type ProjectionResponse = {
  baseCurrency: string;
  goal: { id: string; name: string; term: "short" | "long"; targetDate: string; currency: string };
  targetMinor: number;
  allocatedMinor: number;
  progressPct: number;
  requiredMonthlyMinor: number;
  onTrack: boolean;
  aheadByMinor: number;
  series: GoalProjectionPoint[];
};

async function fetchProjection(id: string): Promise<ProjectionResponse> {
  const { data, error } = await api.goals({ id }).projection.get({ query: { historyMonths: 12 } });
  if (error) throw new Error(String(error));
  return data as unknown as ProjectionResponse;
}

export function GoalDetailPage() {
  const { id } = useParams({ from: "/goals/$id" });
  const nav = useNavigate();
  const [editOpen, setEditOpen] = useState(false);

  const { data: rows = [] } = useLiveQuery(goalsCollection);
  const row = rows.find((g) => g.id === id);

  const projQ = useQuery({
    queryKey: ["goals", "projection", id, row?.targetAmountMinor, row?.targetDate],
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
              <Eyebrow className="mb-2">{p.goal.term === "short" ? "Short term" : "Long term"}</Eyebrow>
              <h1 className="font-heading text-3xl tracking-tight">{p.goal.name}</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {formatMoney(p.targetMinor, base)} by {p.goal.targetDate}
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
                    onClick={async () => {
                      goalsCollection.delete(id);
                      await nav({ to: "/goals" });
                    }}
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

          <div className="grid gap-4 md:grid-cols-[220px_1fr]">
            <section className="rounded-2xl border border-border bg-card p-4">
              <GoalDonut allocatedMinor={p.allocatedMinor} targetMinor={p.targetMinor} progressPct={p.progressPct} />
              <dl className="mt-3 space-y-1 text-sm tabular-nums">
                <div className="flex justify-between"><dt className="text-muted-foreground">Allocated</dt><dd>{formatMoney(p.allocatedMinor, base)}</dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">Target</dt><dd>{formatMoney(p.targetMinor, base)}</dd></div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Required</dt>
                  <dd>{p.requiredMonthlyMinor > 0 ? `${formatMoney(p.requiredMonthlyMinor, base)}/mo` : "—"}</dd>
                </div>
              </dl>
            </section>

            <section className="rounded-2xl border border-border bg-card px-4 py-4 md:px-6 md:py-5">
              <Eyebrow className="mb-3">Projection</Eyebrow>
              <GoalProjectionChart
                series={p.series}
                targetMinor={p.targetMinor}
                targetDate={p.goal.targetDate}
                baseCurrency={base}
              />
            </section>
          </div>
        </>
      )}
    </AppShell>
  );
}
