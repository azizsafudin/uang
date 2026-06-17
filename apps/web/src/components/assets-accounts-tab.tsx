import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { Money } from "@/components/money.tsx";
import { subtypeLabel } from "@/components/labels";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AllocationDonut, type AllocationSlice } from "@/components/allocation-donut";
import { groupsCollection } from "@/lib/collections";
import { useUsers } from "@/lib/use-users";
import type { AccountValuation } from "@/lib/account-grouping";

type Dimension = "type" | "currency" | "owner" | "liquidity";
const DIMENSIONS: { key: Dimension; label: string }[] = [
  { key: "type", label: "By type" },
  { key: "currency", label: "Currency" },
  { key: "owner", label: "Owner" },
  { key: "liquidity", label: "Liquidity" },
];

// Bucket asset accounts by the chosen dimension, summing base value. Accounts
// missing a rate are excluded (no reliable base value). Returns largest-first.
function bucketize(
  accounts: AccountValuation[],
  dim: Dimension,
  userName: (id: string) => string,
): AllocationSlice[] {
  const totals = new Map<string, number>();
  for (const a of accounts) {
    if (a.missingRate) continue;
    let label: string;
    if (dim === "type") label = subtypeLabel(a.subtype);
    else if (dim === "currency") label = a.currency;
    else if (dim === "liquidity") label = a.illiquid ? "Illiquid" : "Liquid";
    else label = a.ownerIds.length >= 2 ? "Shared" : a.ownerIds.map(userName).join(", ") || "Unassigned";
    totals.set(label, (totals.get(label) ?? 0) + a.baseMinor);
  }
  return [...totals.entries()]
    .map(([label, valueBaseMinor]) => ({ label, valueBaseMinor }))
    .sort((a, b) => b.valueBaseMinor - a.valueBaseMinor);
}

type Section = { id: string; name: string; accounts: AccountValuation[]; subtotal: number };

const subtotalOf = (xs: AccountValuation[]) =>
  xs.filter((a) => !a.missingRate).reduce((s, a) => s + a.baseMinor, 0);

// Group asset accounts by their user-defined group (group.sortOrder order),
// ungrouped accounts last. Read-only here — grouping is managed on the dashboard.
function sectionize(
  accounts: AccountValuation[],
  groups: { id: string; name: string; sortOrder: number }[],
): Section[] {
  const known = new Set(groups.map((g) => g.id));
  const out: Section[] = [];
  for (const g of [...groups].sort((a, b) => a.sortOrder - b.sortOrder)) {
    const mem = accounts.filter((a) => a.groupId === g.id).sort((a, b) => b.baseMinor - a.baseMinor);
    if (mem.length > 0) out.push({ id: g.id, name: g.name, accounts: mem, subtotal: subtotalOf(mem) });
  }
  const ungrouped = accounts
    .filter((a) => !a.groupId || !known.has(a.groupId))
    .sort((a, b) => b.baseMinor - a.baseMinor);
  if (ungrouped.length > 0) {
    out.push({ id: "__ungrouped", name: "Ungrouped", accounts: ungrouped, subtotal: subtotalOf(ungrouped) });
  }
  return out;
}

export function AssetsAccountsTab({
  accounts,
  baseCurrency,
}: {
  accounts: AccountValuation[]; // asset accounts only, already owner-filtered
  baseCurrency: string;
}) {
  const [dim, setDim] = useState<Dimension>("type");
  const { data: users } = useUsers();
  const { data: allGroups } = useLiveQuery(groupsCollection);
  const userName = useMemo(() => {
    const m = new Map((users ?? []).map((u) => [u.id, u.name] as const));
    return (id: string) => m.get(id) ?? "Unknown";
  }, [users]);

  const total = accounts.filter((a) => !a.missingRate).reduce((sum, a) => sum + a.baseMinor, 0);
  const slices = useMemo(() => bucketize(accounts, dim, userName), [accounts, dim, userName]);
  const sections = useMemo(
    () => sectionize(accounts, (allGroups ?? []).filter((g) => g.class === "asset")),
    [accounts, allGroups],
  );

  if (accounts.length === 0) {
    return <p className="mt-6 text-sm text-muted-foreground">No assets yet.</p>;
  }

  return (
    <div className="mt-6 space-y-6">
      <div className="flex flex-wrap gap-1.5">
        {DIMENSIONS.map((d) => (
          <Button
            key={d.key}
            size="sm"
            variant={dim === d.key ? "default" : "outline"}
            onClick={() => setDim(d.key)}
            className={cn(dim === d.key && "pointer-events-none")}
          >
            {d.label}
          </Button>
        ))}
      </div>

      <AllocationDonut slices={slices} baseCurrency={baseCurrency} />

      <div className="space-y-5">
        {sections.map((sec) => (
          <div key={sec.id}>
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">{sec.name}</span>
              <span className="text-xs tabular-nums text-muted-foreground">
                <Money minor={sec.subtotal} currency={baseCurrency} />
              </span>
            </div>
            <ul className="rounded-2xl border border-border bg-card">
              {sec.accounts.map((a) => {
                const pct = total > 0 && !a.missingRate ? Math.round((a.baseMinor / total) * 100) : 0;
                return (
                  <li key={a.id} className="border-b border-border/60 last:border-b-0">
                    <Link
                      to="/accounts/$id"
                      params={{ id: a.id }}
                      data-testid="account-row"
                      className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-accent/40"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm">{a.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {a.currency} · {subtypeLabel(a.subtype)}
                        </p>
                      </div>
                      <div className="text-right">
                        {a.missingRate ? (
                          <span className="text-sm text-destructive">missing rate</span>
                        ) : (
                          <>
                            <p className="text-sm tabular-nums">
                              <Money minor={a.baseMinor} currency={baseCurrency} />
                            </p>
                            <p className="text-[0.7rem] tabular-nums text-muted-foreground">{pct}%</p>
                          </>
                        )}
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
