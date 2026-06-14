import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { signOut } from "@/lib/auth";
import { api } from "@/lib/api";
import { formatMoney } from "@/components/money";
import { subtypeLabel } from "@/components/labels";
import { AccountForm } from "@/components/account-form";
import { AppShell, Eyebrow } from "@/components/app-layout";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { NetWorthToggle } from "@/components/net-worth-toggle";
import { NetWorthChart } from "@/components/net-worth-chart";
import { OwnersBadge } from "@/components/owners-badge";

type NetWorth = {
  baseCurrency: string;
  totalBaseMinor: number;
  accounts: Array<{
    id: string;
    name: string;
    class: string;
    subtype: string;
    currency: string;
    balanceMinor: number;
    baseMinor: number;
    missingRate: boolean;
    ownerIds: string[];
    shared: boolean;
  }>;
};

async function fetchNw(owner: string): Promise<NetWorth> {
  const { data, error } = await api.networth.get({ query: { owner } });
  if (error) throw new Error(String(error));
  return data as unknown as NetWorth;
}

const GROUPS = [
  { cls: "asset", label: "Assets" },
  { cls: "liability", label: "Liabilities" },
] as const;

export function DashboardPage() {
  const nav = useNavigate();
  const [owner, setOwner] = useState("household");

  // The account list + group totals always reflect the whole household, so the
  // list never changes when you toggle the headline.
  const { data: listData, isLoading } = useQuery({
    queryKey: ["networth", "household"],
    queryFn: () => fetchNw("household"),
  });

  // The headline follows the toggle. (owner === "household" dedupes with the list query.)
  const { data: headline } = useQuery({
    queryKey: ["networth", owner],
    queryFn: () => fetchNw(owner),
  });

  const base = listData?.baseCurrency ?? "";
  const accounts = listData?.accounts ?? [];
  const groupTotal = (cls: string) =>
    accounts
      .filter((a) => a.class === cls && !a.missingRate)
      .reduce((sum, a) => sum + a.baseMinor, 0);

  return (
    <AppShell
      actions={
        <>
          <AccountForm />
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
        {GROUPS.map(({ cls, label }) => {
          const rows = accounts.filter((a) => a.class === cls);
          return (
            <section key={cls}>
              <div className="mb-3 flex items-baseline justify-between">
                <Eyebrow>{label}</Eyebrow>
                {listData && rows.length > 0 && (
                  <span className="font-heading text-sm tabular-nums text-muted-foreground">
                    {formatMoney(groupTotal(cls), base)}
                  </span>
                )}
              </div>

              {rows.length === 0 ? (
                <p className="text-sm text-muted-foreground">None yet.</p>
              ) : (
                <div className="overflow-hidden rounded-xl border border-border bg-card">
                  {rows.map((a, i) => (
                    <Link
                      key={a.id}
                      data-testid="account-row"
                      to="/accounts/$id"
                      params={{ id: a.id }}
                      className={cn(
                        "flex items-center justify-between gap-4 px-4 py-3.5 transition-colors hover:bg-accent",
                        i > 0 && "border-t border-border/70",
                      )}
                    >
                      <div className="min-w-0">
                        <p className="truncate font-medium">{a.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {subtypeLabel(a.subtype)} · {a.currency}
                          {a.missingRate && (
                            <span className="ml-1.5 rounded-full bg-destructive/10 px-1.5 py-0.5 text-[0.65rem] font-medium text-destructive">
                              no FX rate
                            </span>
                          )}
                        </p>
                        <div className="mt-1">
                          <OwnersBadge ownerIds={a.ownerIds} />
                        </div>
                      </div>
                      <div className="shrink-0 text-right tabular-nums">
                        <p
                          className={cn(
                            "font-medium",
                            a.balanceMinor < 0 && "text-destructive",
                          )}
                        >
                          {formatMoney(a.balanceMinor, a.currency)}
                        </p>
                        {a.currency !== base && !a.missingRate && (
                          <p className="text-xs text-muted-foreground">
                            {formatMoney(a.baseMinor, base)}
                          </p>
                        )}
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </AppShell>
  );
}
