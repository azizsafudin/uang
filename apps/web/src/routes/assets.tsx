import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { AppShell } from "@/components/app-layout";
import { PageHeader } from "@/components/page-header";
import { Money } from "@/components/money.tsx";
import { NetWorthToggle } from "@/components/net-worth-toggle";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AssetsAccountsTab } from "@/components/assets-accounts-tab";
import { AssetsHoldingsTab } from "@/components/assets-holdings-tab";
import { visibleForOwner, type AccountValuation } from "@/lib/account-grouping";

type NetWorth = { baseCurrency: string; accounts: AccountValuation[] };

async function fetchNw(): Promise<NetWorth> {
  const { data, error } = await api.networth.get({ query: { owner: "household" } });
  if (error) throw new Error(String(error));
  return data as unknown as NetWorth;
}

export function AssetsPage() {
  const [owner, setOwner] = useState("household");
  const [tab, setTab] = useState("accounts");

  // Fetch the whole household once; the owner toggle filters client-side.
  const { data } = useQuery({ queryKey: ["networth", "household"], queryFn: fetchNw });
  const base = data?.baseCurrency ?? "";
  const assetAccounts = visibleForOwner(data?.accounts ?? [], owner).filter((a) => a.class === "asset");
  const total = assetAccounts.filter((a) => !a.missingRate).reduce((sum, a) => sum + a.baseMinor, 0);

  return (
    <AppShell>
      <PageHeader
        eyebrow="Holdings"
        title="Assets"
        actions={<NetWorthToggle value={owner} onChange={setOwner} />}
      />
      <p data-testid="assets-total" className="-mt-3 font-heading text-4xl tabular-nums tracking-tight">
        {data ? <Money minor={total} currency={base} /> : "—"}
      </p>

      <Tabs value={tab} onValueChange={(v) => typeof v === "string" && setTab(v)} className="mt-8">
        <TabsList variant="line" className="w-full justify-start">
          <TabsTrigger value="accounts" className="flex-none px-3">Accounts</TabsTrigger>
          <TabsTrigger value="holdings" className="flex-none px-3">Holdings</TabsTrigger>
        </TabsList>

        <TabsContent value="accounts">
          <AssetsAccountsTab accounts={assetAccounts} baseCurrency={base} />
        </TabsContent>
        <TabsContent value="holdings">
          <AssetsHoldingsTab owner={owner} />
        </TabsContent>
      </Tabs>
    </AppShell>
  );
}
