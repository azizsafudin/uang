import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import { Link, useNavigate } from "@tanstack/react-router";
import { signOut } from "@/lib/auth";
import { api } from "@/lib/api";
import { formatMoney } from "@/components/money";
import { cn } from "@/lib/utils";
import { AccountForm } from "@/components/account-form";
import { AppShell, Eyebrow } from "@/components/app-layout";
import { Button } from "@/components/ui/button";
import { NetWorthToggle } from "@/components/net-worth-toggle";
import { NetWorthChart } from "@/components/net-worth-chart";
import { DashboardSection, type AccountValuation } from "@/components/dashboard-section";
import { groupsCollection } from "@/lib/collections";

type NetWorth = {
  baseCurrency: string;
  totalBaseMinor: number;
  accounts: AccountValuation[];
};

async function fetchNw(owner: string): Promise<NetWorth> {
  const { data, error } = await api.networth.get({ query: { owner } });
  if (error) throw new Error(String(error));
  return data as unknown as NetWorth;
}

const CLASS_SECTIONS = [
  { cls: "asset", label: "Assets" },
  { cls: "liability", label: "Liabilities" },
] as const;

export function DashboardPage() {
  const nav = useNavigate();
  const [owner, setOwner] = useState("household");

  // The account list + group totals always reflect the whole household, so the
  // list never changes when you toggle the headline.
  const { data: listData } = useQuery({
    queryKey: ["networth", "household"],
    queryFn: () => fetchNw("household"),
  });

  // The headline follows the toggle. (owner === "household" dedupes with the list query.)
  const { data: headline } = useQuery({
    queryKey: ["networth", owner],
    queryFn: () => fetchNw(owner),
  });

  const { data: allGroups } = useLiveQuery(groupsCollection);

  const base = listData?.baseCurrency ?? "";
  const accounts = listData?.accounts ?? [];

  return (
    <AppShell
      actions={
        <>
          <AccountForm defaultCurrency={base || undefined} />
          <Link to="/goals" className="text-sm font-medium text-primary hover:underline">
            Goals →
          </Link>
          <Link to="/projections" className="text-sm font-medium text-primary hover:underline">
            Projections →
          </Link>
          <Link to="/settings">
            <Button variant="ghost" size="sm">
              Settings
            </Button>
          </Link>
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              await signOut();
              await nav({ to: "/login" });
            }}
          >
            Sign out
          </Button>
        </>
      }
    >
      <div className="mb-4">
        <NetWorthToggle value={owner} onChange={setOwner} />
      </div>

      {/* Hero: net worth for the selected vantage point, minted in Fraunces. */}
      <section className="rounded-2xl border border-border bg-card px-6 py-7 shadow-sm md:px-8 md:py-9">
        <Eyebrow>
          Net worth · {owner === "household" ? "household" : "personal"} · as of today
        </Eyebrow>
        <p
          data-testid="networth-hero"
          className={cn(
            "mt-3 font-heading text-5xl tracking-tight tabular-nums md:text-6xl",
            headline && headline.totalBaseMinor < 0 && "text-destructive",
          )}
        >
          {!headline ? "—" : formatMoney(headline.totalBaseMinor, headline.baseCurrency)}
        </p>
      </section>

      <div className="mt-6">
        <NetWorthChart owner={owner} />
      </div>

      <div className="mt-9 space-y-8">
        {CLASS_SECTIONS.map(({ cls, label }) => {
          const sectionAccounts = accounts.filter((a) => a.class === cls);
          const sectionGroups = (allGroups ?? []).filter((g) => g.class === cls);
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
