import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { type AccountRow } from "@/lib/collections";
import { SectionCard } from "@/components/section-card";
import { KVRow } from "@/components/account-info-card";
import { AccountProjectionForm } from "@/components/account-projection-form";

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

  return (
    <SectionCard title="Projection" editing={editing} onToggle={() => setEditing((e) => !e)}>
      {!editing && (
        <div className="py-1.5">
          <KVRow label="Growth" value={growth} />
          <KVRow label="Accessible" value={`From age ${account.accessibleFromAge}`} />
          <KVRow label="Early" value={earlyAccess} />
          <KVRow label="Illiquid" value={illiquid} />
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
