import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import { Pencil } from "lucide-react";
import { api } from "@/lib/api";
import { AppShell } from "@/components/app-layout";
import { Button } from "@/components/ui/button";
import { NetWorthChart } from "@/components/net-worth-chart";
import { DashboardSection, type AccountValuation } from "@/components/dashboard-section";
import { DashboardHero } from "@/components/dashboard-hero";
import { DashboardTiles } from "@/components/dashboard-tiles/dashboard-tiles";
import { groupsCollection } from "@/lib/collections";
import { visibleForOwner } from "@/lib/account-grouping";
import { TILE_REGISTRY, type TileData } from "@/lib/dashboard-tiles/registry";

type NetWorth = {
  baseCurrency: string;
  totalBaseMinor: number;
  accounts: AccountValuation[];
};

type SeriesPoint = { date: string; totalBaseMinor: number };
type Series = { baseCurrency: string; points: SeriesPoint[] };

type GoalAnalysis = { id: string; onTrack: boolean };
type AnalysisResponse = {
  baseCurrency: string;
  goals: GoalAnalysis[];
  overall: { onTrack: boolean; behindCount: number };
};

async function fetchNw(owner: string): Promise<NetWorth> {
  const { data, error } = await api.networth.get({ query: { owner } });
  if (error) throw new Error(String(error));
  return data as unknown as NetWorth;
}

function startOfMonthISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

async function fetchSeries(from: string, owner: string): Promise<Series> {
  const { data, error } = await api.networth.series.get({ query: { from, owner } });
  if (error) throw new Error(String(error));
  return data as unknown as Series;
}

async function fetchAnalysis(): Promise<AnalysisResponse> {
  const { data, error } = await api.goals.analysis.get();
  if (error) throw new Error(String(error));
  return data as unknown as AnalysisResponse;
}

const CLASS_SECTIONS = [
  { cls: "asset", label: "Assets" },
  { cls: "liability", label: "Liabilities" },
] as const;

export function DashboardPage() {
  const [owner, setOwner] = useState("household");
  const [editingTiles, setEditingTiles] = useState(false);

  // Always fetch the whole-household list once; the owner toggle then filters it
  // client-side (see `visibleForOwner` below) so we don't refetch per owner.
  const { data: listData } = useQuery({
    queryKey: ["networth", "household"],
    queryFn: () => fetchNw("household"),
  });

  // The headline follows the toggle. (owner === "household" dedupes with the list query.)
  const { data: headline } = useQuery({
    queryKey: ["networth", owner],
    queryFn: () => fetchNw(owner),
  });

  const { data: seriesData } = useQuery({
    queryKey: ["networth-series", owner, startOfMonthISO()],
    queryFn: () => fetchSeries(startOfMonthISO(), owner),
  });

  const { data: allGroups } = useLiveQuery(groupsCollection);
  const { data: analysis } = useQuery({ queryKey: ["goals", "analysis"], queryFn: fetchAnalysis });

  const base = listData?.baseCurrency ?? "";
  const allAccounts = listData?.accounts ?? [];
  const accounts = visibleForOwner(allAccounts, owner);

  const points = seriesData?.points ?? [];
  const periodDeltaMinor =
    headline && points.length > 0 ? headline.totalBaseMinor - points[0].totalBaseMinor : null;
  const periodPct =
    periodDeltaMinor !== null && points[0]?.totalBaseMinor
      ? (periodDeltaMinor / Math.abs(points[0].totalBaseMinor)) * 100
      : null;

  const tileData: TileData = useMemo(
    () => ({
      baseCurrency: base,
      accounts: accounts.map((a) => ({ class: a.class, baseMinor: a.baseMinor, illiquid: a.illiquid })),
      goalsTotal: analysis?.goals.length ?? 0,
      goalsOnTrack: analysis?.goals.filter((g) => g.onTrack).length ?? 0,
      periodDeltaMinor,
    }),
    [base, accounts, analysis, periodDeltaMinor],
  );

  // Only offer tile editing once at least one tile actually has data to show.
  const hasAvailableTiles = useMemo(
    () => TILE_REGISTRY.some((t) => t.isAvailable(tileData)),
    [tileData],
  );

  return (
    <AppShell>
      <DashboardHero
        owner={owner}
        totalBaseMinor={headline ? headline.totalBaseMinor : null}
        baseCurrency={headline?.baseCurrency ?? base}
        series={points}
        changeMinor={periodDeltaMinor}
        changePct={periodPct}
        tiles={
          <DashboardTiles
            data={tileData}
            baseCurrency={base}
            editing={editingTiles}
            onEditingChange={setEditingTiles}
          />
        }
        actions={
          hasAvailableTiles && !editingTiles ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              onClick={() => setEditingTiles(true)}
              aria-label="Edit tiles"
            >
              <Pencil className="size-4" />
            </Button>
          ) : undefined
        }
      />

      <div className="mt-6">
        <NetWorthChart owner={owner} onOwnerChange={setOwner} />
      </div>

      <div className="mt-9 space-y-8">
        {CLASS_SECTIONS.map(({ cls, label }) => {
          const sectionAccounts = accounts.filter((a) => a.class === cls);
          const sectionAllAccounts = allAccounts.filter((a) => a.class === cls);
          const sectionGroups = (allGroups ?? [])
            .filter((g) => g.class === cls)
            .filter((g) => {
              if (owner === "household") return true;
              // Keep genuinely-empty groups (drag-in target); hide groups that
              // have household members but none visible for the selected owner.
              const hasHouseholdMembers = sectionAllAccounts.some((a) => a.groupId === g.id);
              const hasVisibleMembers = sectionAccounts.some((a) => a.groupId === g.id);
              return !hasHouseholdMembers || hasVisibleMembers;
            });
          const sectionTotal = sectionAccounts
            .filter((a) => !a.missingRate)
            .reduce((sum, a) => sum + a.baseMinor, 0);

          return (
            <DashboardSection
              key={cls}
              cls={cls}
              label={label}
              accounts={sectionAccounts}
              groups={sectionGroups}
              baseCurrency={base}
              sectionTotalMinor={sectionTotal}
              hasData={!!listData}
            />
          );
        })}
      </div>
    </AppShell>
  );
}
