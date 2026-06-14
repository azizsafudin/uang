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
  }>;
};

async function fetchNw(): Promise<NetWorth> {
  const { data, error } = await api.networth.get({ query: {} });
  if (error) throw new Error(String(error));
  return data as unknown as NetWorth;
}

const GROUPS = [
  { cls: "asset", label: "Assets" },
  { cls: "liability", label: "Liabilities" },
] as const;

export function DashboardPage() {
  const nav = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ["networth"],
    queryFn: fetchNw,
  });

  const base = data?.baseCurrency ?? "";
  const accounts = data?.accounts ?? [];
  const groupTotal = (cls: string) =>
    accounts
      .filter((a) => a.class === cls && !a.missingRate)
      .reduce((sum, a) => sum + a.baseMinor, 0);

  return (
    <AppShell
      actions={
        <>
          <AccountForm />
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
      {/* Hero: the household's net worth, minted in Fraunces. */}
      <section className="rounded-2xl border border-border bg-card px-6 py-7 shadow-sm md:px-8 md:py-9">
        <Eyebrow>Net worth · as of today</Eyebrow>
        <p
          className={cn(
            "mt-3 font-heading text-5xl tracking-tight tabular-nums md:text-6xl",
            data && data.totalBaseMinor < 0 && "text-destructive",
          )}
        >
          {isLoading || !data ? "—" : formatMoney(data.totalBaseMinor, base)}
        </p>
      </section>

      <div className="mt-9 space-y-8">
        {GROUPS.map(({ cls, label }) => {
          const rows = accounts.filter((a) => a.class === cls);
          return (
            <section key={cls}>
              <div className="mb-3 flex items-baseline justify-between">
                <Eyebrow>{label}</Eyebrow>
                {data && rows.length > 0 && (
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
