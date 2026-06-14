import { useQuery } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import { Link } from "@tanstack/react-router";
import { api } from "@/lib/api";
import { goalsCollection } from "@/lib/collections";
import { formatMoney } from "@/components/money";
import { GoalForm } from "@/components/goal-form";
import { AppShell, Eyebrow } from "@/components/app-layout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";

type GoalAnalysis = {
  id: string; name: string; term: "short" | "long"; targetAmountMinor: number;
  targetDate: string; currency: string; allocatedMinor: number; progressPct: number;
  projectedAllocatedMinor: number; gapMinor: number; requiredMonthlyMinor: number;
  onPlanTodayMinor: number; aheadByMinor: number; onTrack: boolean;
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
        {analysisQ.data && (
          <span className="text-sm text-muted-foreground">
            Unallocated:{" "}
            <span className="font-medium tabular-nums text-foreground">
              {formatMoney(analysisQ.data.unallocatedMinor, base)}
            </span>
          </span>
        )}
      </div>

      <div className="space-y-8">
        {TERMS.map(({ key, label }) => {
          const termRows = rows.filter((g) => g.term === key);
          return (
            <section key={key}>
              <Eyebrow className="mb-3">{label}</Eyebrow>
              {termRows.length === 0 ? (
                <p className="text-sm text-muted-foreground">None yet.</p>
              ) : (
                <div className="space-y-3">
                  {termRows.map((g) => {
                    const a = byId.get(g.id);
                    return (
                      <div key={g.id} className="rounded-2xl border border-border bg-card p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate font-medium">{g.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {formatMoney(g.targetAmountMinor, g.currency)} by {g.targetDate}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            {a && (
                              <Badge variant={a.onTrack ? "default" : "destructive"}>
                                {a.onTrack ? "On track" : "Behind"}
                              </Badge>
                            )}
                            <GoalForm goal={g} defaultCurrency={base || undefined} />
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="text-muted-foreground hover:text-destructive"
                              onClick={() => goalsCollection.delete(g.id)}
                            >
                              ✕
                            </Button>
                          </div>
                        </div>

                        {a && (
                          <div className="mt-3 space-y-2">
                            <Progress value={a.progressPct} />
                            <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
                              <span>
                                {formatMoney(a.allocatedMinor, base)} allocated · {a.progressPct}%
                              </span>
                              <span>
                                {a.requiredMonthlyMinor > 0
                                  ? `${formatMoney(a.requiredMonthlyMinor, base)}/mo to fund`
                                  : "Fully funded"}
                              </span>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </AppShell>
  );
}
