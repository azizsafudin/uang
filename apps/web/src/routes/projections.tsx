import { ProjectionChart } from "@/components/projection-chart";

export function ProjectionsPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-6 md:py-10">
      <h1 className="mb-1 text-xl font-semibold">Projections</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        Total vs accessible net worth over time, at your assumed growth rates.
      </p>
      <ProjectionChart />
    </main>
  );
}
