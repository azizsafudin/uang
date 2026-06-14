import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { accountsCollection, type AccountRow } from "@/lib/collections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { KVRow, Field } from "@/components/account-info-card";
import { SectionCard } from "@/components/section-card";

// UI shows percent; storage is basis points.
const toPct = (bps: number) => String(bps / 100);
const fromPct = (s: string) => Math.round((parseFloat(s) || 0) * 100);

function seedForm(account: AccountRow) {
  return {
    growthPct: toPct(account.growthRateBps),
    accessibleFromAge: String(account.accessibleFromAge),
    earlyWithdrawal: account.earlyWithdrawal,
    earlyHaircutPct: toPct(account.earlyHaircutBps),
    illiquid: account.illiquid === 1,
    liquidationAge: account.liquidationAge == null ? "" : String(account.liquidationAge),
  };
}

// How this account behaves in the long-term net-worth forecast: growth rate, when
// the money becomes accessible, and liquidity. Read view + inline edit, mirroring
// AccountInfoCard.
export function AccountProjectionCard({ account }: { account: AccountRow }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState(() => seedForm(account));

  function openEdit() {
    setF(seedForm(account));
    setEditing(true);
  }
  function cancel() {
    setEditing(false);
  }

  async function save() {
    accountsCollection.update(account.id, (draft) => {
      draft.growthRateBps = fromPct(f.growthPct);
      draft.accessibleFromAge = parseInt(f.accessibleFromAge, 10) || 0;
      draft.earlyWithdrawal = f.earlyWithdrawal;
      draft.earlyHaircutBps = fromPct(f.earlyHaircutPct);
      draft.illiquid = f.illiquid ? 1 : 0;
      draft.liquidationAge = f.liquidationAge === "" ? null : parseInt(f.liquidationAge, 10);
    });
    await qc.invalidateQueries({ queryKey: ["networth"] });
    setEditing(false);
  }

  const accessible =
    account.accessibleFromAge > 0 ? `From age ${account.accessibleFromAge}` : "Any time";
  const beforeAge =
    account.accessibleFromAge > 0
      ? account.earlyWithdrawal === "penalty"
        ? `Withdraw with ${toPct(account.earlyHaircutBps)}% penalty`
        : "Locked"
      : null;
  const liquidity =
    account.illiquid === 1
      ? account.liquidationAge != null
        ? `Illiquid · liquidates at age ${account.liquidationAge}`
        : "Illiquid"
      : "Liquid";

  return (
    <SectionCard title="Projection" editing={editing} onToggle={editing ? cancel : openEdit}>
      {!editing && (
        <div className="py-1.5">
          <KVRow label="Growth" value={`${toPct(account.growthRateBps)}% / year`} />
          <KVRow label="Accessible" value={accessible} />
          {beforeAge && <KVRow label="Before" value={beforeAge} />}
          <KVRow label="Liquidity" value={liquidity} />
        </div>
      )}

      {editing && (
        <div>
          <div className="flex flex-col gap-4 p-4">
            <div className="grid grid-cols-2 gap-4">
              <Field label="Annual growth %">
                <Input
                  type="number"
                  step="any"
                  value={f.growthPct}
                  onChange={(e) => setF((p) => ({ ...p, growthPct: e.target.value }))}
                />
              </Field>
              <Field label="Accessible from age">
                <Input
                  type="number"
                  min="0"
                  value={f.accessibleFromAge}
                  onChange={(e) => setF((p) => ({ ...p, accessibleFromAge: e.target.value }))}
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Before that age">
                <Select
                  value={f.earlyWithdrawal}
                  onValueChange={(v: string | null) =>
                    v && setF((p) => ({ ...p, earlyWithdrawal: v as AccountRow["earlyWithdrawal"] }))
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue>
                      {(v: unknown) => (String(v) === "penalty" ? "Withdraw with penalty" : "Locked")}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Locked</SelectItem>
                    <SelectItem value="penalty">Withdraw with penalty</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Early penalty %">
                <Input
                  type="number"
                  min="0"
                  step="any"
                  value={f.earlyHaircutPct}
                  disabled={f.earlyWithdrawal !== "penalty"}
                  onChange={(e) => setF((p) => ({ ...p, earlyHaircutPct: e.target.value }))}
                />
              </Field>
            </div>
            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <span className="text-sm">Illiquid (exclude from accessible)</span>
              <Switch
                checked={f.illiquid}
                onCheckedChange={(v: boolean) => setF((p) => ({ ...p, illiquid: v }))}
              />
            </div>
            {f.illiquid && (
              <Field label="Liquidation age (optional)">
                <Input
                  type="number"
                  min="0"
                  value={f.liquidationAge}
                  placeholder="never"
                  onChange={(e) => setF((p) => ({ ...p, liquidationAge: e.target.value }))}
                />
              </Field>
            )}
          </div>
          <div className="flex gap-2 border-t border-border bg-muted px-4 py-3">
            <Button size="sm" onClick={save}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </SectionCard>
  );
}
