import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import { Link } from "@tanstack/react-router";
import { api } from "@/lib/api";
import { goalsCollection } from "@/lib/collections";
import { type GoalRow } from "@/lib/collections";
import { formatMoney } from "@/components/money";
import { formatDate } from "@/lib/utils";
import { GoalForm } from "@/components/goal-form";
import { GoalDonut } from "@/components/goal-donut";
import { useDestructiveAction } from "@/lib/use-destructive-action";
import { AppShell, Eyebrow } from "@/components/app-layout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";

type GoalAnalysis = {
  id: string; name: string; term: "short" | "long"; targetAmountMinor: number;
  targetDate: string; currency: string; allocatedMinor: number; progressPct: number;
  projectedAllocatedMinor: number; gapMinor: number; requiredMonthlyMinor: number;
  onPlanTodayMinor: number; aheadByMinor: number; onTrack: boolean;
  sources: Array<{ accountId: string; name: string; allocatedMinor: number }>;
};
type AnalysisResponse = {
  baseCurrency: string; contributionGrowthRateBps: number; unallocatedMinor: number;
  goals: GoalAnalysis[]; overall: { onTrack: boolean; behindCount: number };
};

async function fetchAnalysis(): Promise<AnalysisResponse> {
  const { data, error } = await api.goals.analysis.get();
  if (error) throw new Error(String(error));
  return data as unknown as AnalysisResponse;
}

const TERMS = [
  { key: "short", label: "Short term" },
  { key: "long", label: "Long term" },
] as const;

function GoalCard({ g, a, base }: { g: GoalRow; a: GoalAnalysis | undefined; base: string }) {
  const [editOpen, setEditOpen] = useState(false);
  const { confirm, dialog } = useDestructiveAction();
  return (
    <div className="relative rounded-2xl border border-border bg-card">
      <Link
        to="/goals/$id"
        params={{ id: g.id }}
        className="flex items-center gap-4 rounded-2xl p-4 pr-12 transition-colors hover:bg-accent"
        data-testid="goal-card"
      >
        {a && (
          <div className="shrink-0">
            <GoalDonut
              sources={a.sources}
              allocatedMinor={a.allocatedMinor}
              targetMinor={a.targetAmountMinor}
              progressPct={a.progressPct}
              size={72}
            />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{g.name}</p>
          <p className="text-xs text-muted-foreground">
            {formatMoney(g.targetAmountMinor, g.currency)} by {formatDate(g.targetDate)}
          </p>
          {a && (
            <>
              <div className="mt-2">
                <Badge variant={a.onTrack ? "default" : "destructive"}>
                  {a.onTrack ? "On track" : "Behind"}
                </Badge>
              </div>
              <div className="mt-3 space-y-2">
                <Progress value={a.progressPct} />
                <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
                  <span>{formatMoney(a.allocatedMinor, base)} allocated · {a.progressPct}%</span>
                  <span>
                    {a.requiredMonthlyMinor > 0
                      ? `${formatMoney(a.requiredMonthlyMinor, base)}/mo to fund`
                      : "Fully funded"}
                  </span>
                </div>
              </div>
            </>
          )}
        </div>
      </Link>

      <div className="absolute right-2 top-2">
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
                  description: `"${g.name}" will be permanently removed. This can't be undone.`,
                  onConfirm: () => { goalsCollection.delete(g.id); },
                })
              }
            >
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {/* Controlled edit dialog (no own trigger); opened from the menu item. */}
        <GoalForm goal={g} defaultCurrency={base || undefined} open={editOpen} onOpenChange={setEditOpen} hideTrigger />
      </div>
      {dialog}
    </div>
  );
}

export function GoalsPage() {
  // Live goal rows drive create/edit/delete; the analysis query provides the math.
  const { data: rows = [] } = useLiveQuery(goalsCollection);
  // Refetch the analysis whenever any goal's funding-relevant fields change (not
  // just the count), so editing a target amount/date updates progress + on-track.
  const goalsSignature = rows
    .map((g) => `${g.id}:${g.targetAmountMinor}:${g.targetDate}:${g.term}:${g.ownerScope}`)
    .sort()
    .join("|");
  const analysisQ = useQuery({ queryKey: ["goals", "analysis", goalsSignature], queryFn: fetchAnalysis });
  const base = analysisQ.data?.baseCurrency ?? "";
  const byId = new Map((analysisQ.data?.goals ?? []).map((g) => [g.id, g]));

  return (
    <AppShell
      actions={
        <>
          <GoalForm defaultCurrency={base || undefined} />
          <Link to="/">
            <Button variant="ghost" size="sm">← Back</Button>
          </Link>
        </>
      }
    >
      <div className="mb-6 flex items-baseline justify-between">
        <h1 className="font-heading text-3xl tracking-tight">Goals</h1>
        {analysisQ.data && analysisQ.data.unallocatedMinor !== 0 && (
          <span className="text-sm text-muted-foreground">
            Unallocated:{" "}
            <span className="font-medium tabular-nums text-foreground">
              {formatMoney(analysisQ.data.unallocatedMinor, base)}
            </span>
          </span>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-card/50 px-6 py-16 text-center">
          <p className="font-heading text-lg">No goals yet</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            Create a goal to track how your net worth funds it over time, with required
            contributions and an on-track projection.
          </p>
          <div className="mt-4 flex justify-center">
            <GoalForm defaultCurrency={base || undefined} />
          </div>
        </div>
      ) : (
        <div className="space-y-8">
          {TERMS.map(({ key, label }) => {
            const termRows = rows.filter((g) => g.term === key);
            if (termRows.length === 0) return null;
            return (
              <section key={key}>
                <Eyebrow className="mb-3">{label}</Eyebrow>
                <div className="space-y-3">
                  {termRows.map((g) => (
                    <GoalCard key={g.id} g={g} a={byId.get(g.id)} base={base} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </AppShell>
  );
}
