import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { type AccountRow } from "@/lib/collections";
import { SectionCard } from "@/components/section-card";
import { KVRow } from "@/components/account-info-card";
import { AccountProjectionForm } from "@/components/account-projection-form";
import { formatMoney } from "@/components/money";

const pct = (bps: number) => `${bps / 100}%`;

// Read-only summary of an account's projection assumptions, mirroring the
// /projections page. Editing reuses the same `AccountProjectionForm`, shown
// inline in place of the summary (matching the Details tab's edit pattern).
export function AccountProjectionCard({ account }: { account: AccountRow }) {
  const [editing, setEditing] = useState(false);

  const settingsQ = useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const { data, error } = await api.settings.get();
      if (error) throw new Error(String(error));
      return data as unknown as { baseCurrency: string };
    },
  });
  const baseCurrency = settingsQ.data?.baseCurrency ?? "";

  const isLiability = account.class === "liability";

  const growth =
    account.compoundInterval === "annually"
      ? `${pct(account.growthRateBps)}/yr`
      : `${pct(account.growthRateBps)}/yr · ${account.compoundInterval}`;

  const earlyAccess =
    account.earlyWithdrawal === "penalty"
      ? `Withdraw with ${pct(account.earlyHaircutBps)} penalty`
      : "Locked";

  const illiquid =
    account.illiquid === 1
      ? account.liquidationAge != null
        ? `Yes · liquidates at ${account.liquidationAge}`
        : "Yes"
      : "No";

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
    <SectionCard title="Projection" editing={editing} onToggle={() => setEditing((e) => !e)}>
      {!editing && (
        <div className="py-1.5">
          <KVRow label="Growth" value={growth} />
          <KVRow label="Accessible" value={`From age ${account.accessibleFromAge}`} />
          <KVRow label="Early" value={earlyAccess} />
          <KVRow label="Illiquid" value={illiquid} />
          <KVRow label="Contribution" value={contribution} empty="None" />
          {!isLiability && <KVRow label="Withdrawal" value={withdrawal} empty="No withdrawal" />}
        </div>
      )}

      {editing && (
        <div className="p-4">
          <AccountProjectionForm
            account={account}
            baseCurrency={baseCurrency}
            onClose={() => setEditing(false)}
          />
        </div>
      )}
    </SectionCard>
  );
}
