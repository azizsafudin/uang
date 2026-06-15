import { ProjectionChart } from "@/components/projection-chart";
import { AppShell } from "@/components/app-layout";
import { PageHeader } from "@/components/page-header";

export function ProjectionsPage() {
  return (
    <AppShell>
      <PageHeader title="Projections" description="Total vs accessible net worth over time, at your assumed growth rates." />
      <ProjectionChart />
    </AppShell>
  );
}
