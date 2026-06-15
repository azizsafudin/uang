import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { currencyDecimals } from "@uang/shared";
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
import { Field } from "@/components/account-info-card";

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
type CompoundInterval = AccountRow["compoundInterval"];

const SPEND_LABELS: Record<SpendType, string> = {
  none: "None (no withdrawal)",
  once: "One-time withdrawal",
  monthly: "Monthly income",
  percent: "% of balance / yr",
};

const COMPOUND_LABELS: Record<CompoundInterval, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  annually: "Annually",
};

function seedForm(account: AccountRow, base: string) {
  return {
    growthPct: toPct(account.growthRateBps),
    accessibleFromAge: String(account.accessibleFromAge),
    earlyWithdrawal: account.earlyWithdrawal,
    earlyHaircutPct: toPct(account.earlyHaircutBps),
    illiquid: account.illiquid === 1,
    liquidationAge: account.liquidationAge == null ? "" : String(account.liquidationAge),
    contribution: account.contributionMinor ? toMajor(account.contributionMinor, base) : "",
    contributionUntilAge:
      account.contributionUntilAge == null ? "" : String(account.contributionUntilAge),
    compoundInterval: account.compoundInterval,
    spendType: account.spendType,
    spendAmount: account.spendAmountMinor == null ? "" : toMajor(account.spendAmountMinor, base),
    spendRate: account.spendRateBps == null ? "" : toPct(account.spendRateBps),
    spendStartKind: account.spendStartKind,
    spendStartAge: account.spendStartAge == null ? "" : String(account.spendStartAge),
    spendStartTarget:
      account.spendStartTargetMinor == null ? "" : toMajor(account.spendStartTargetMinor, base),
  };
}

// The projection assumptions + decumulation (withdrawal) editor for one account.
// Rendered inside the edit dialog on /projections. Amounts are base currency.
// Liabilities never withdraw, so the withdrawal block is hidden for them.
export function AccountProjectionForm({
  account,
  baseCurrency,
  onClose,
}: {
  account: AccountRow;
  baseCurrency: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [f, setF] = useState(() => seedForm(account, baseCurrency));
  const isLiability = account.class === "liability";

  async function save() {
    accountsCollection.update(account.id, (draft) => {
      draft.growthRateBps = fromPct(f.growthPct);
      draft.accessibleFromAge = parseInt(f.accessibleFromAge, 10) || 0;
      draft.earlyWithdrawal = f.earlyWithdrawal;
      draft.earlyHaircutBps = fromPct(f.earlyHaircutPct);
      draft.illiquid = f.illiquid ? 1 : 0;
      draft.liquidationAge = f.liquidationAge === "" ? null : parseInt(f.liquidationAge, 10);
      // Accumulation.
      draft.contributionMinor = toMinor(f.contribution, baseCurrency);
      draft.contributionUntilAge =
        f.contributionUntilAge === "" ? null : parseInt(f.contributionUntilAge, 10);
      draft.compoundInterval = f.compoundInterval;
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
    onClose();
  }

  return (
    <div>
      <div className="flex flex-col gap-4">
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

        <div className="grid grid-cols-2 gap-4 border-t border-border pt-4">
          <Field label={`Monthly contribution (${baseCurrency})`}>
            <Input
              type="number"
              step="any"
              min="0"
              placeholder="0"
              value={f.contribution}
              onChange={(e) => setF((p) => ({ ...p, contribution: e.target.value }))}
            />
          </Field>
          <Field label="Contribute until age">
            <Input
              type="number"
              min="0"
              placeholder="no limit"
              value={f.contributionUntilAge}
              onChange={(e) => setF((p) => ({ ...p, contributionUntilAge: e.target.value }))}
            />
          </Field>
          <Field label="Compound">
            <Select
              value={f.compoundInterval}
              onValueChange={(v: string | null) =>
                v && setF((p) => ({ ...p, compoundInterval: v as CompoundInterval }))
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue>{(v: unknown) => COMPOUND_LABELS[v as CompoundInterval]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(COMPOUND_LABELS) as CompoundInterval[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {COMPOUND_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

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
                  f.spendType === "once" ? `Lump (${baseCurrency})` : `Per month (${baseCurrency})`
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
                        {(v: unknown) => (String(v) === "target" ? "Target balance" : "Owner age")}
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
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={save}>Save</Button>
      </div>
    </div>
  );
}
