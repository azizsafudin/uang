import { useLiveQuery } from "@tanstack/react-db";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { membersCollection } from "@/lib/collections";
import { ProjectionChart } from "@/components/projection-chart";
import { GoalsList } from "@/components/goals-list";
import { ProjectionAccounts } from "@/components/projection-accounts";
import { AppShell, Section } from "@/components/app-layout";
import { PageHeader } from "@/components/page-header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function ProjectionAssumptionsSection() {
  const qc = useQueryClient();
  const settingsQ = useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const { data, error } = await api.settings.get();
      if (error) throw new Error(String(error));
      return data as unknown as {
        baseCurrency: string; contributionGrowthRateBps: number; projectionEndAge: number;
      };
    },
  });

  async function patch(body: { contributionGrowthRateBps?: number; projectionEndAge?: number }) {
    const { error } = await api.settings.patch(body);
    if (error) throw new Error(String(error));
    await qc.invalidateQueries({ queryKey: ["settings"] });
    await qc.invalidateQueries({ queryKey: ["goals", "analysis"] });
  }

  const s = settingsQ.data;
  return (
    <Section
      eyebrow="Projections"
      title="Assumptions"
      description="The annual return used to solve required goal contributions, and how far the projection curve runs."
    >
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label>Contribution return %</Label>
          <Input
            type="number"
            step="any"
            className="w-32"
            defaultValue={s ? s.contributionGrowthRateBps / 100 : ""}
            onBlur={(e) => {
              const v = Math.round((parseFloat(e.target.value) || 0) * 100);
              if (s && v !== s.contributionGrowthRateBps) patch({ contributionGrowthRateBps: v });
            }}
          />
        </div>
        <div>
          <Label>Project until age</Label>
          <Input
            type="number"
            min={1}
            className="w-32"
            defaultValue={s?.projectionEndAge ?? ""}
            onBlur={(e) => {
              const v = Math.max(1, parseInt(e.target.value, 10) || 90);
              if (s && v !== s.projectionEndAge) patch({ projectionEndAge: v });
            }}
          />
        </div>
      </div>
    </Section>
  );
}

function MembersSection() {
  const { data: members = [] } = useLiveQuery(membersCollection);
  return (
    <Section eyebrow="Projections" title="Member birth years">
      <div className="space-y-3">
        {members.map((m) => (
          <div key={m.id} className="flex items-center justify-between gap-3">
            <Label className="flex-1">{m.name}</Label>
            <Input
              type="number"
              min={1900}
              max={new Date().getFullYear()}
              className="w-32"
              placeholder="Birth year"
              defaultValue={m.birthYear ?? ""}
              onBlur={(e) => {
                const v = e.target.value === "" ? null : parseInt(e.target.value, 10);
                if (v !== (m.birthYear ?? null)) {
                  membersCollection.update(m.id, (draft) => { draft.birthYear = v; });
                }
              }}
            />
          </div>
        ))}
      </div>
    </Section>
  );
}

export function PlanPage() {
  return (
    <AppShell>
      <PageHeader title="Plan" description="Your net worth over time, the goals it funds, and the accounts behind them." />
      <div className="space-y-6">
        <ProjectionChart />
        <section>
          <h2 className="mb-3 font-heading text-lg">Goals</h2>
          <GoalsList />
        </section>
        <section>
          <h2 className="mb-3 font-heading text-lg">Accounts</h2>
          <ProjectionAccounts />
        </section>
        <div className="grid gap-5 md:grid-cols-2">
          <MembersSection />
          <ProjectionAssumptionsSection />
        </div>
      </div>
    </AppShell>
  );
}
