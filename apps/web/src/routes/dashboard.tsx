import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import { Link, useNavigate } from "@tanstack/react-router";
import { signOut } from "@/lib/auth";
import { api } from "@/lib/api";
import { formatMoney } from "@/components/money";
import { cn } from "@/lib/utils";
import { AccountForm } from "@/components/account-form";
import { AccountRow } from "@/components/account-row";
import { AccountGroupRow } from "@/components/account-group-row";
import { AppShell, Eyebrow } from "@/components/app-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NetWorthToggle } from "@/components/net-worth-toggle";
import { NetWorthChart } from "@/components/net-worth-chart";
import { groupsCollection, newId } from "@/lib/collections";

type AccountValuation = {
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
  groupId: string | null;
  sortOrder: number;
};

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
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [newGroupSection, setNewGroupSection] = useState<"asset" | "liability" | null>(null);
  const [newGroupName, setNewGroupName] = useState("");

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

  function toggleGroup(groupId: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  async function createGroup(cls: "asset" | "liability") {
    if (!newGroupName.trim()) return;
    const id = newId();
    await groupsCollection.insert({
      id,
      name: newGroupName.trim(),
      class: cls,
      sortOrder: 0,
      createdAt: Math.floor(Date.now() / 1000),
    });
    setNewGroupSection(null);
    setNewGroupName("");
    setExpandedGroups((prev) => new Set(prev).add(id));
  }

  function sectionTotal(cls: string) {
    return accounts
      .filter((a) => a.class === cls && !a.missingRate)
      .reduce((sum, a) => sum + a.baseMinor, 0);
  }

  return (
    <AppShell
      actions={
        <>
          <AccountForm defaultCurrency={base || undefined} />
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
          const sectionAccounts = accounts
            .filter((a) => a.class === cls)
            .sort((a, b) => a.sortOrder - b.sortOrder);

          const sectionGroups = (allGroups ?? [])
            .filter((g) => g.class === cls)
            .sort((a, b) => a.sortOrder - b.sortOrder);

          type ListItem =
            | { type: "group"; groupId: string }
            | { type: "account"; account: AccountValuation };

          const items: ListItem[] = [];
          for (const g of sectionGroups) {
            items.push({ type: "group", groupId: g.id });
          }
          for (const a of sectionAccounts.filter((a) => !a.groupId)) {
            items.push({ type: "account", account: a });
          }

          return (
            <section key={cls}>
              <div className="mb-3 flex items-center justify-between">
                <Eyebrow>{label}</Eyebrow>
                <div className="flex items-center gap-3">
                  {listData && sectionAccounts.length > 0 && (
                    <span className="font-heading text-sm tabular-nums text-muted-foreground">
                      {formatMoney(sectionTotal(cls), base)}
                    </span>
                  )}
                  {newGroupSection === cls ? (
                    <div className="flex items-center gap-1.5">
                      <Input
                        autoFocus
                        value={newGroupName}
                        onChange={(e) => setNewGroupName(e.target.value)}
                        placeholder="Group name"
                        className="h-7 w-32 text-xs"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void createGroup(cls);
                          if (e.key === "Escape") {
                            setNewGroupSection(null);
                            setNewGroupName("");
                          }
                        }}
                      />
                      <Button
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => void createGroup(cls)}
                        disabled={!newGroupName.trim()}
                      >
                        Create
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        onClick={() => {
                          setNewGroupSection(null);
                          setNewGroupName("");
                        }}
                      >
                        ✕
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-xs text-muted-foreground"
                      onClick={() => setNewGroupSection(cls)}
                    >
                      + New group
                    </Button>
                  )}
                </div>
              </div>

              {items.length === 0 ? (
                <p className="text-sm text-muted-foreground">None yet.</p>
              ) : (
                <div className="overflow-hidden rounded-xl border border-border bg-card">
                  {items.map((item) => {
                    if (item.type === "group") {
                      const g = sectionGroups.find((g) => g.id === item.groupId)!;
                      const members = sectionAccounts.filter((a) => a.groupId === g.id);
                      const subtotal = members
                        .filter((a) => !a.missingRate)
                        .reduce((sum, a) => sum + a.baseMinor, 0);
                      const expanded = expandedGroups.has(g.id);

                      return (
                        <div key={g.id}>
                          <AccountGroupRow
                            name={g.name}
                            memberCount={members.length}
                            subtotalMinor={subtotal}
                            baseCurrency={base}
                            expanded={expanded}
                            onToggle={() => toggleGroup(g.id)}
                          />
                          {expanded &&
                            members.map((a, i) => (
                              <div key={a.id} className="border-t border-border/70 pl-4">
                                <AccountRow
                                  account={a}
                                  baseCurrency={base}
                                  isLast={i === members.length - 1}
                                />
                              </div>
                            ))}
                        </div>
                      );
                    }

                    return (
                      <AccountRow
                        key={item.account.id}
                        account={item.account}
                        baseCurrency={base}
                        isLast={false}
                      />
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </AppShell>
  );
}
