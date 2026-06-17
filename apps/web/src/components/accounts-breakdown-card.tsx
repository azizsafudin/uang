import { useMemo } from "react";
import { useUsers } from "@/lib/use-users";
import { AllocationDonut } from "@/components/allocation-donut";
import { bucketize, type Dimension } from "@/components/assets-accounts-tab";
import type { AccountValuation } from "@/lib/account-grouping";

// A titled card showing one /assets "Accounts" breakdown dimension (e.g.
// Liquidity or Owner) as a donut + legend over the given asset accounts.
export function AccountsBreakdownCard({
  title,
  dim,
  accounts,
  baseCurrency,
}: {
  title: string;
  dim: Dimension;
  accounts: AccountValuation[];
  baseCurrency: string;
}) {
  const { data: users } = useUsers();
  const userName = useMemo(() => {
    const m = new Map((users ?? []).map((u) => [u.id, u.name] as const));
    return (id: string) => m.get(id) ?? "Unknown";
  }, [users]);
  const slices = useMemo(() => bucketize(accounts, dim, userName), [accounts, dim, userName]);

  return (
    <div className="rounded-[14px] border border-border bg-card px-5 py-4">
      <h3 className="font-heading text-lg font-semibold tracking-tight">{title}</h3>
      <div className="mt-3">
        {slices.length === 0 ? (
          <p className="text-sm text-muted-foreground">No accounts yet.</p>
        ) : (
          <AllocationDonut slices={slices} baseCurrency={baseCurrency} size={112} />
        )}
      </div>
    </div>
  );
}
