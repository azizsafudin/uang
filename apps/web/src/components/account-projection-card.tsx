import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { currencyDecimals } from "@uang/shared";
import { accountsCollection, type AccountRow } from "@/lib/collections";
import { formatMoney } from "@/components/money";
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
// Withdrawal amounts are in BASE currency.
const toMajor = (minor: number, currency: string) =>
  String(minor / 10 ** currencyDecimals(currency));
const toMinor = (major: string, currency: string) =>
  Math.round((parseFloat(major) || 0) * 10 ** currencyDecimals(currency));

type SpendType = AccountRow["spendType"];
type SpendStartKind = AccountRow["spendStartKind"];

const SPEND_LABELS: Record<SpendType, string> = {
  none: "None (no withdrawal)",
  once: "One-time withdrawal",
  monthly: "Monthly income",
  percent: "% of balance / yr",
};

function seedForm(account: AccountRow, base: string) {
  return {
    growthPct: toPct(account.growthRateBps),
    accessibleFromAge: String(account.accessibleFromAge),
    earlyWithdrawal: account.earlyWithdrawal,
    earlyHaircutPct: toPct(account.earlyHaircutBps),
    illiquid: account.illiquid === 1,
    liquidationAge: account.liquidationAge == null ? "" : String(account.liquidationAge),
    spendType: account.spendType,
    spendAmount: account.spendAmountMinor == null ? "" : toMajor(account.spendAmountMinor, base),
    spendRate: account.spendRateBps == null ? "" : toPct(account.spendRateBps),
    spendStartKind: account.spendStartKind,
    spendStartAge: account.spendStartAge == null ? "" : String(account.spendStartAge),
    spendStartTarget:
      account.spendStartTargetMinor == null ? "" : toMajor(account.spendStartTargetMinor, base),
  };
}

// How this account behaves in the long-term net-worth forecast: growth, when the
// money becomes accessible, liquidity, and decumulation (withdrawals). Read view +
// inline edit. Lives on /projections (one card per account). Amounts are base currency.
export function AccountProjectionCard({
  account,
  baseCurrency,
}: {
  account: AccountRow;
  baseCurrency: string;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState(() => seedForm(account, baseCurrency));
  const isLiability = account.class === "liability";

  function openEdit() {
    setF(seedForm(account, baseCurrency));
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
      // Decumulation. Liabilities never withdraw.
      const spendType: SpendType = isLiability ? "none" : f.spendType;
      draft.spendType = spendType;
      draft.spendAmountMinor =
        spendType === "once" || spendType === "monthly"
          ? toMinor(f.spendAmount, baseCurrency)
          : null;
      draft.spendRateBps = spendType === "percent" ? fromPct(f.spendRate) : null;
      draft.spendStartKind = f.spendStartKind;
      draft.spendStartAge =
        spendType !== "none" && f.spendStartKind === "age"
          ? parseInt(f.spendStartAge, 10) || 0
          : null;
      draft.spendStartTargetMinor =
        spendType !== "none" && f.spendStartKind === "target"
          ? toMinor(f.spendStartTarget, baseCurrency)
          : null;
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

  const withdrawalSummary = (() => {
    if (account.spendType === "none") return "None";
    const when =
      account.spendStartKind === "age"
        ? account.spendStartAge != null
          ? `from age ${account.spendStartAge}`
          : "—"
        : account.spendStartTargetMinor != null
          ? `once balance hits ${formatMoney(account.spendStartTargetMinor, baseCurrency)}`
          : "—";
    if (account.spendType === "percent") return `${toPct(account.spendRateBps ?? 0)}%/yr ${when}`;
    if (account.spendType === "monthly")
      return `${formatMoney(account.spendAmountMinor ?? 0, baseCurrency)}/mo ${when}`;
    return `${formatMoney(account.spendAmountMinor ?? 0, baseCurrency)} once ${when}`;
  })();

  return (
    <SectionCard title={account.name} editing={editing} onToggle={editing ? cancel : openEdit}>
      {!editing && (
        <div className="py-1.5">
          <KVRow label="Growth" value={`${toPct(account.growthRateBps)}% / year`} />
          <KVRow label="Accessible" value={accessible} />
          {beforeAge && <KVRow label="Before" value={beforeAge} />}
          <KVRow label="Liquidity" value={liquidity} />
          {!isLiability && <KVRow label="Withdrawal" value={withdrawalSummary} />}
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

            {!isLiability && (
              <div className="grid grid-cols-2 gap-4 border-t border-border pt-4">
                <Field label="Withdrawal">
                  <Select
                    value={f.spendType}
                    onValueChange={(v: string | null) =>
                      v && setF((p) => ({ ...p, spendType: v as SpendType }))
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue>{(v: unknown) => SPEND_LABELS[v as SpendType]}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(SPEND_LABELS) as SpendType[]).map((k) => (
                        <SelectItem key={k} value={k}>
                          {SPEND_LABELS[k]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>

                {(f.spendType === "once" || f.spendType === "monthly") && (
                  <Field
                    label={
                      f.spendType === "once"
                        ? `Lump (${baseCurrency})`
                        : `Per month (${baseCurrency})`
                    }
                  >
                    <Input
                      type="number"
                      step="any"
                      min="0"
                      value={f.spendAmount}
                      onChange={(e) => setF((p) => ({ ...p, spendAmount: e.target.value }))}
                    />
                  </Field>
                )}

                {f.spendType === "percent" && (
                  <Field label="Withdrawal rate (%/yr)">
                    <Input
                      type="number"
                      step="any"
                      min="0"
                      placeholder="4"
                      value={f.spendRate}
                      onChange={(e) => setF((p) => ({ ...p, spendRate: e.target.value }))}
                    />
                  </Field>
                )}

                {f.spendType !== "none" && (
                  <>
                    <Field label="Starts on">
                      <Select
                        value={f.spendStartKind}
                        onValueChange={(v: string | null) =>
                          v && setF((p) => ({ ...p, spendStartKind: v as SpendStartKind }))
                        }
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue>
                            {(v: unknown) =>
                              String(v) === "target" ? "Target balance" : "Owner age"
                            }
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="age">Owner age</SelectItem>
                          <SelectItem value="target">Target balance</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                    {f.spendStartKind === "age" ? (
                      <Field label="Start at age">
                        <Input
                          type="number"
                          min="0"
                          value={f.spendStartAge}
                          onChange={(e) => setF((p) => ({ ...p, spendStartAge: e.target.value }))}
                        />
                      </Field>
                    ) : (
                      <Field label={`Target balance (${baseCurrency})`}>
                        <Input
                          type="number"
                          step="any"
                          min="0"
                          value={f.spendStartTarget}
                          onChange={(e) => setF((p) => ({ ...p, spendStartTarget: e.target.value }))}
                        />
                      </Field>
                    )}
                  </>
                )}
              </div>
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
