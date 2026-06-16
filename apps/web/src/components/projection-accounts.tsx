import { useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { loanMonthlyPaymentMinor } from "@uang/shared";
import { api } from "@/lib/api";
import { formatMoney } from "@/components/money";
import { Eyebrow } from "@/components/app-layout";
import { AccountRow } from "@/components/account-row";
import { AccountGroupRow } from "@/components/account-group-row";
import { AccountProjectionForm } from "@/components/account-projection-form";
import {
  accountsCollection,
  groupsCollection,
  type GroupRow,
  type AccountRow as AccountRecord,
} from "@/lib/collections";
import { build, isOwnerCard, ownerIdsOf, type AccountValuation } from "@/lib/account-grouping";
import { useUsers, type Member } from "@/lib/use-users";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog";

type NetWorthData = {
  baseCurrency: string;
  totalBaseMinor: number;
  accounts: AccountValuation[];
};

async function fetchNetWorth(): Promise<NetWorthData> {
  const { data, error } = await api.networth.get({ query: { owner: "household" } });
  if (error) throw new Error(String(error));
  return data as unknown as NetWorthData;
}

const pct = (bps: number) => `${bps / 100}%`;

// Total months -> "4y", "4y 6m", or "6m".
const fmtTerm = (months: number): string => {
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (y && m) return `${y}y ${m}m`;
  if (y) return `${y}y`;
  return `${m}m`;
};

// The growth + withdrawal config to show per account row (in place of its balance).
function ProjectionConfig({ account, baseCurrency }: { account: AccountRecord; baseCurrency: string }) {
  const isLiability = account.class === "liability";

  if (isLiability) {
    const term = account.loanTermMonths ?? 0;
    const rateLine =
      term > 0
        ? `${pct(account.growthRateBps)}/yr · ${fmtTerm(term)}`
        : `${pct(account.growthRateBps)}/yr`;
    const payment =
      term > 0 ? loanMonthlyPaymentMinor(account.balanceMinor, account.growthRateBps, term) : 0;
    return (
      <>
        <p className="text-sm font-medium tabular-nums">{rateLine}</p>
        <p className="text-xs text-muted-foreground">
          {term > 0 ? `${formatMoney(payment, account.currency)}/mo` : "no term"}
        </p>
      </>
    );
  }

  const growth =
    account.compoundInterval === "annually"
      ? `${pct(account.growthRateBps)}/yr`
      : `${pct(account.growthRateBps)}/yr · ${account.compoundInterval}`;

  const contribution =
    account.contributionMinor > 0
      ? `+${formatMoney(account.contributionMinor, baseCurrency)}/mo${
          account.contributionUntilAge != null ? ` until ${account.contributionUntilAge}` : ""
        }`
      : null;

  let withdrawal: string | null = null;
  if (!isLiability && account.spendType !== "none") {
    const when =
      account.spendStartKind === "age"
        ? account.spendStartAge != null
          ? `from age ${account.spendStartAge}`
          : ""
        : account.spendStartTargetMinor != null
          ? `at ${formatMoney(account.spendStartTargetMinor, baseCurrency)}`
          : "";
    const amount =
      account.spendType === "percent"
        ? `${pct(account.spendRateBps ?? 0)}/yr`
        : account.spendType === "monthly"
          ? `${formatMoney(account.spendAmountMinor ?? 0, baseCurrency)}/mo`
          : `${formatMoney(account.spendAmountMinor ?? 0, baseCurrency)} once`;
    withdrawal = `${amount} ${when}`.trim();
  }

  return (
    <>
      <p className="text-sm font-medium tabular-nums">{growth}</p>
      {contribution && <p className="text-xs text-primary">{contribution}</p>}
      <p className="text-xs text-muted-foreground">
        {withdrawal ?? (isLiability ? "—" : "no withdrawal")}
      </p>
    </>
  );
}

const CLASS_SECTIONS = [
  { cls: "asset", label: "Assets" },
  { cls: "liability", label: "Liabilities" },
] as const;

// The dashboard's grouped account layout, read-only (no drag/reorder, no group
// management). Clicking an account opens a dialog to edit its projection settings.
// Same groups + same order as the dashboard (shared `build` from account-grouping).
export function ProjectionAccounts() {
  const { data: nw } = useQuery({ queryKey: ["networth", "household"], queryFn: fetchNetWorth });
  const { data: allGroups } = useLiveQuery(groupsCollection);
  const { data: fullAccounts = [] } = useLiveQuery(accountsCollection);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const base = nw?.baseCurrency ?? "";
  const accounts = nw?.accounts ?? [];

  const recordById = new Map<string, AccountRecord>();
  for (const a of fullAccounts) recordById.set(a.id, a);
  const selected = selectedId ? (recordById.get(selectedId) ?? null) : null;

  if (!nw || accounts.length === 0) return null;

  return (
    <div className="space-y-6">
      {CLASS_SECTIONS.map(({ cls, label }) => (
        <ReadonlySection
          key={cls}
          label={label}
          accounts={accounts.filter((a) => a.class === cls)}
          groups={(allGroups ?? []).filter((g) => g.class === cls)}
          baseCurrency={base}
          recordById={recordById}
          onSelect={setSelectedId}
        />
      ))}

      <ProjectionEditDialog
        account={selected}
        baseCurrency={base}
        onClose={() => setSelectedId(null)}
      />
    </div>
  );
}

function ReadonlySection({
  label,
  accounts,
  groups,
  baseCurrency,
  recordById,
  onSelect,
}: {
  label: string;
  accounts: AccountValuation[];
  groups: GroupRow[];
  baseCurrency: string;
  recordById: Map<string, AccountRecord>;
  onSelect: (id: string) => void;
}) {
  const { data: users } = useUsers();
  const memberById = new Map<string, Member>();
  for (const u of users ?? []) memberById.set(u.id, u);

  function ownerLabel(cardId: string): string {
    const ids = ownerIdsOf(cardId);
    if (ids.length === 0) return "Unowned";
    const names = ids.map((id) => memberById.get(id)?.name ?? "…");
    if (ids.length === 1) return names[0];
    return "Shared · " + names.join(", ");
  }

  // `toggled` tracks deviations from each card's default (matching the dashboard):
  // groups default collapsed (in-set = expanded); owner buckets default expanded
  // (in-set = collapsed).
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  function toggle(id: string) {
    setToggled((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const acctById = new Map<string, AccountValuation>();
  for (const a of accounts) acctById.set(a.id, a);

  const { order, members } = build(groups, accounts);
  const sectionTotal = accounts
    .filter((a) => !a.missingRate)
    .reduce((sum, a) => sum + a.baseMinor, 0);

  const cards = order.filter((id) => (members[id]?.length ?? 0) > 0);
  if (cards.length === 0) return null;

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <Eyebrow>{label}</Eyebrow>
        <span className="font-heading text-sm tabular-nums text-muted-foreground">
          {formatMoney(sectionTotal, baseCurrency)}
        </span>
      </div>
      <div className="space-y-3">
        {cards.map((cardId) => {
          const memberIds = members[cardId] ?? [];
          const bucket = isOwnerCard(cardId);
          const group = bucket ? null : groups.find((g) => g.id === cardId);
          if (!bucket && !group) return null;
          const cardName = bucket ? ownerLabel(cardId) : (group?.name ?? "");

          const subtotal = memberIds
            .map((id) => acctById.get(id))
            .filter((a): a is AccountValuation => a !== undefined)
            .filter((a) => !a.missingRate)
            .reduce((sum, a) => sum + a.baseMinor, 0);

          const expanded = bucket ? !toggled.has(cardId) : toggled.has(cardId);

          return (
            <div key={cardId} className="overflow-hidden rounded-xl border border-border bg-card">
              <AccountGroupRow
                name={cardName}
                memberCount={memberIds.length}
                subtotalMinor={subtotal}
                baseCurrency={baseCurrency}
                expanded={expanded}
                onToggle={() => toggle(cardId)}
              />
              {expanded && (
                <div className="border-t border-border/70">
                  {memberIds.map((aid, i) => {
                    const acct = acctById.get(aid);
                    if (!acct) return null;
                    const record = recordById.get(aid);
                    return (
                      <AccountRow
                        key={aid}
                        account={acct}
                        baseCurrency={baseCurrency}
                        isLast={i === memberIds.length - 1}
                        onSelect={() => onSelect(aid)}
                        trailing={
                          record ? (
                            <ProjectionConfig account={record} baseCurrency={baseCurrency} />
                          ) : null
                        }
                      />
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ProjectionEditDialog({
  account,
  baseCurrency,
  onClose,
}: {
  account: AccountRecord | null;
  baseCurrency: string;
  onClose: () => void;
}) {
  return (
    <ResponsiveDialog open={account !== null} onOpenChange={(open) => !open && onClose()}>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{account?.name ?? "Account"}</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        {account && (
          <AccountProjectionForm account={account} baseCurrency={baseCurrency} onClose={onClose} />
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
