import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import { Link } from "@tanstack/react-router";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { api } from "@/lib/api";
import { goalsCollection } from "@/lib/collections";
import { type GoalRow } from "@/lib/collections";
import { Money } from "@/components/money.tsx";
import { useMoney } from "@/lib/values-hidden";
import { formatDate } from "@/lib/utils";
import { GoalForm } from "@/components/goal-form";
import { GoalDonut } from "@/components/goal-donut";
import { useDestructiveAction } from "@/lib/use-destructive-action";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";

type GoalAnalysis = {
  id: string;
  name: string;
  targetAmountMinor: number;
  targetDate: string | null;
  currency: string;
  allocatedMinor: number;
  progressPct: number;
  monthlyContributionMinor: number;
  requiredMonthlyMinor: number;
  projectedAtTargetMinor: number | null;
  onTrack: boolean;
  reachDate: string | null;
  spendType: "none" | "once" | "monthly" | "percent";
  annualIncomeMinor: number | null;
  sources: Array<{ accountId: string; name: string; allocatedMinor: number }>;
};

type AnalysisResponse = {
  baseCurrency: string;
  contributionGrowthRateBps: number;
  unallocatedMinor: number;
  goals: GoalAnalysis[];
  overall: { onTrack: boolean; behindCount: number };
};

async function fetchAnalysis(): Promise<AnalysisResponse> {
  const { data, error } = await api.goals.analysis.get();
  if (error) throw new Error(String(error));
  return data as unknown as AnalysisResponse;
}

function SortableGoalCard({
  g,
  a,
  base,
}: {
  g: GoalRow;
  a: GoalAnalysis | undefined;
  base: string;
}) {
  const money = useMoney();
  const [editOpen, setEditOpen] = useState(false);
  const { confirm, dialog } = useDestructiveAction();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: g.id,
  });
  const style = { transform: CSS.Transform.toString(transform), transition };

  return (
    <div
      ref={setNodeRef}
      style={{ ...style, opacity: isDragging ? 0.6 : undefined }}
      className="relative rounded-2xl border border-border bg-card"
    >
      {/* Drag handle */}
      <button
        {...attributes}
        {...listeners}
        className="absolute left-2 top-1/2 -translate-y-1/2 cursor-grab touch-none p-1 text-muted-foreground hover:text-foreground active:cursor-grabbing"
        aria-label="Drag to reorder"
        tabIndex={-1}
      >
        <GripVertical size={16} />
      </button>

      <Link
        to="/goals/$id"
        params={{ id: g.id }}
        className="flex items-center gap-4 rounded-2xl p-4 pl-9 pr-12 transition-colors hover:bg-accent"
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
            <Money minor={g.targetAmountMinor} currency={g.currency} />
            {g.targetDate ? ` by ${formatDate(g.targetDate)}` : " · no deadline"}
            {a &&
              a.spendType === "monthly" &&
              a.annualIncomeMinor !== null &&
              ` · income ≈ ${money(a.annualIncomeMinor, base)}/yr`}
            {a &&
              a.spendType === "percent" &&
              a.annualIncomeMinor !== null &&
              ` · drawdown ≈ ${money(a.annualIncomeMinor, base)}/yr`}
            {a && a.spendType === "once" && " · one-time spend"}
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
                  <span>
                    <Money minor={a.allocatedMinor} currency={base} /> allocated · {a.progressPct}%
                  </span>
                  <span>
                    {a.onTrack
                      ? `Reaches ${a.reachDate ? formatDate(a.reachDate) : "target"}`
                      : a.projectedAtTargetMinor !== null
                        ? `${money(a.targetAmountMinor - a.projectedAtTargetMinor, base)} short`
                        : "Not reachable"}
                  </span>
                </div>
              </div>
            </>
          )}
        </div>
      </Link>

      <div className="absolute right-2 top-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon-sm" aria-label="Goal actions" />}
          >
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
                  onConfirm: () => {
                    goalsCollection.delete(g.id);
                  },
                })
              }
            >
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {/* Controlled edit dialog (no own trigger); opened from the menu item. */}
        <GoalForm
          goal={g}
          defaultCurrency={base || undefined}
          open={editOpen}
          onOpenChange={setEditOpen}
          hideTrigger
        />
      </div>
      {dialog}
    </div>
  );
}

export function GoalsList() {
  // Live goal rows drive create/edit/delete; the analysis query provides the math.
  const { data: rows = [] } = useLiveQuery(goalsCollection);
  // Refetch the analysis whenever any goal's funding-relevant fields change (not
  // just the count), so editing a target amount/date updates progress + on-track.
  const goalsSignature = rows
    .map(
      (g) =>
        `${g.id}:${g.targetAmountMinor}:${g.targetDate}:${g.ownerScope}:${g.monthlyContributionMinor}:${g.spendType}:${g.spendAmountMinor}:${g.spendRateBps}`,
    )
    .sort()
    .join("|");
  const analysisQ = useQuery({
    queryKey: ["goals", "analysis", goalsSignature],
    queryFn: fetchAnalysis,
  });
  const base = analysisQ.data?.baseCurrency ?? "";
  const byId = new Map((analysisQ.data?.goals ?? []).map((g) => [g.id, g]));

  // Sort by sortOrder (drag-persisted), falling back to the original priority
  // order (soonest deadline first, then smallest target, then id).
  const ordered = [...rows].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    const ad = a.targetDate ?? "9999-99-99";
    const bd = b.targetDate ?? "9999-99-99";
    if (ad !== bd) return ad < bd ? -1 : 1;
    if (a.targetAmountMinor !== b.targetAmountMinor) return a.targetAmountMinor - b.targetAmountMinor;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = ordered.map((g) => g.id);
    const next = arrayMove(
      ids,
      ids.indexOf(String(active.id)),
      ids.indexOf(String(over.id)),
    );
    next.forEach((id, i) =>
      goalsCollection.update(id, (d) => {
        d.sortOrder = i;
      }),
    );
  }

  return (
    <div>
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
        <>
          <div className="mb-3 flex items-center justify-between">
            <GoalForm defaultCurrency={base || undefined} />
            {analysisQ.data && analysisQ.data.unallocatedMinor !== 0 && (
              <span className="text-sm text-muted-foreground">
                Unallocated:{" "}
                <span className="font-medium tabular-nums text-foreground">
                  <Money minor={analysisQ.data.unallocatedMinor} currency={base} />
                </span>
              </span>
            )}
          </div>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onDragEnd}
          >
            <SortableContext items={ordered.map((g) => g.id)} strategy={verticalListSortingStrategy}>
              <div className="space-y-3">
                {ordered.map((g) => (
                  <SortableGoalCard key={g.id} g={g} a={byId.get(g.id)} base={base} />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </>
      )}
    </div>
  );
}
