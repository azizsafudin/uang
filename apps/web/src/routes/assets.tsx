import { AppShell } from "@/components/app-layout";
import { PageHeader } from "@/components/page-header";

// Stub — destined to become the accounts/holdings (asset) breakdown.
export function AssetsPage() {
  return (
    <AppShell>
      <PageHeader eyebrow="Holdings" title="Assets" />
      <p className="mt-6 text-sm text-muted-foreground">Coming soon.</p>
    </AppShell>
  );
}
