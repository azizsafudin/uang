import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { signOut } from "@/lib/auth";
import { api } from "@/lib/api";
import { formatMoney } from "@/components/money";
import { AccountForm } from "@/components/account-form";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
} from "@/components/ui/card";

type NetWorth = {
  baseCurrency: string;
  totalBaseMinor: number;
  totalBaseMinorAssets: number;
  totalBaseMinorLiabilities: number;
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
  // Eden can return an error-body union; cast to the known shape
  return data as unknown as NetWorth;
}

export function DashboardPage() {
  const nav = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ["networth"],
    queryFn: fetchNw,
  });

  const grouped = (cls: string) =>
    (data?.accounts ?? []).filter((a) => a.class === cls);

  return (
    <div className="min-h-screen p-6 md:p-8 max-w-3xl mx-auto space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Uang</h1>
        <div className="flex gap-2">
          <Link to="/settings">
            <Button variant="outline">Settings</Button>
          </Link>
          <Button
            variant="outline"
            onClick={async () => {
              await signOut();
              await nav({ to: "/login" });
            }}
          >
            Sign out
          </Button>
        </div>
      </header>

      <Card>
        <CardHeader>
          <p className="text-sm text-muted-foreground">Net worth</p>
          <p className="text-4xl font-semibold tabular-nums">
            {isLoading || !data
              ? "—"
              : formatMoney(data.totalBaseMinor, data.baseCurrency)}
          </p>
        </CardHeader>
      </Card>

      {(["asset", "liability"] as const).map((cls) => (
        <section key={cls} className="space-y-2">
          <h2 className="text-sm font-medium uppercase text-muted-foreground">
            {cls === "asset" ? "Assets" : "Liabilities"}
          </h2>
          <div className="space-y-2">
            {grouped(cls).map((a) => (
              <Link key={a.id} to="/accounts/$id" params={{ id: a.id }}>
                <Card className="hover:bg-accent cursor-pointer">
                  <CardContent className="p-4 flex items-center justify-between">
                    <div>
                      <p className="font-medium">{a.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {a.subtype} · {a.currency}
                        {a.missingRate ? " · ⚠ no FX rate" : ""}
                      </p>
                    </div>
                    <div className="text-right tabular-nums">
                      <p className="font-medium">
                        {formatMoney(a.balanceMinor, a.currency)}
                      </p>
                      {a.currency !== data?.baseCurrency &&
                        !a.missingRate && (
                          <p className="text-xs text-muted-foreground">
                            {formatMoney(a.baseMinor, data!.baseCurrency)}
                          </p>
                        )}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
            {grouped(cls).length === 0 && (
              <p className="text-sm text-muted-foreground">None yet.</p>
            )}
          </div>
        </section>
      ))}

      <AccountForm />
    </div>
  );
}
