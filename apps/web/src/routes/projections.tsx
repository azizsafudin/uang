import { ProjectionChart } from "@/components/projection-chart";
import { AppShell } from "@/components/app-layout";

export function ProjectionsPage() {
  return (
    <AppShell>
      <h1 className="mb-1 text-xl font-semibold">Projections</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        Total vs accessible net worth over time, at your assumed growth rates.
      </p>
      <ProjectionChart />
    </AppShell>
  );
}
