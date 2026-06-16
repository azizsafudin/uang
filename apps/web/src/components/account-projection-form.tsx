import { useEffect } from "react";
import { useForm, Controller } from "react-hook-form";
import { useQueryClient } from "@tanstack/react-query";
import { currencyDecimals, loanMonthlyPaymentMinor } from "@uang/shared";
import { accountsCollection, type AccountRow } from "@/lib/collections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ResponsiveDialogBody,
  ResponsiveDialogFooter,
} from "@/components/ui/responsive-dialog";
import { Field } from "@/components/account-info-card";

// UI shows percent; storage is basis points.
const toPct = (bps: number) => String(bps / 100);
const fromPct = (s: string) => Math.round((parseFloat(s) || 0) * 100);
// Withdrawal amounts are in BASE currency.
const toMajor = (minor: number, currency: string) =>
  String(minor / 10 ** currencyDecimals(currency));
const toMinor = (major: string, currency: string) =>
  Math.round((parseFloat(major) || 0) * 10 ** currencyDecimals(currency));

// Loan term <-> months. UI edits years + months; storage is total months.
const splitTerm = (months: number | null) => ({
  years: months == null ? "" : String(Math.floor(months / 12)),
  months: months == null ? "" : String(months % 12),
});
const joinTerm = (years: string, months: string): number | null => {
  const y = parseInt(years, 10) || 0;
  const m = parseInt(months, 10) || 0;
  const total = y * 12 + m;
  return total > 0 ? total : null;
};
const fmtMajor = (minor: number, currency: string) =>
  (minor / 10 ** currencyDecimals(currency)).toLocaleString(undefined, {
    minimumFractionDigits: currencyDecimals(currency),
    maximumFractionDigits: currencyDecimals(currency),
  });

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

type FormValues = {
  growthPct: string;
  accessibleFromAge: string;
  earlyWithdrawal: AccountRow["earlyWithdrawal"];
  earlyHaircutPct: string;
  illiquid: boolean;
  liquidationAge: string;
  contribution: string;
  contributionUntilAge: string;
  compoundInterval: CompoundInterval;
  spendType: SpendType;
  spendAmount: string;
  spendRate: string;
  spendStartKind: SpendStartKind;
  spendStartAge: string;
  spendStartTarget: string;
  loanRatePct: string;
  loanTermYears: string;
  loanTermMonths: string;
};

function seedForm(account: AccountRow, base: string): FormValues {
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
    loanRatePct: toPct(account.growthRateBps),
    loanTermYears: splitTerm(account.loanTermMonths).years,
    loanTermMonths: splitTerm(account.loanTermMonths).months,
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
  const isLiability = account.class === "liability";
  const { register, handleSubmit, control, watch, reset } = useForm<FormValues>({
    defaultValues: seedForm(account, baseCurrency),
  });

  useEffect(() => {
    reset(seedForm(account, baseCurrency));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id]);

  const earlyWithdrawal = watch("earlyWithdrawal");
  const illiquid = watch("illiquid");
  const spendType = watch("spendType");
  const spendStartKind = watch("spendStartKind");
  const loanRatePct = watch("loanRatePct");
  const loanTermYears = watch("loanTermYears");
  const loanTermMonths = watch("loanTermMonths");

  async function onSubmit(f: FormValues) {
    accountsCollection.update(account.id, (draft) => {
      if (isLiability) {
        // Single loan model: interest rate + remaining term. Balance comes from
        // transactions; withdrawal/accessibility/contribution are not used.
        draft.growthRateBps = fromPct(f.loanRatePct);
        draft.loanTermMonths = joinTerm(f.loanTermYears, f.loanTermMonths);
        draft.spendType = "none";
        draft.contributionMinor = 0;
        return;
      }
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
      // Decumulation.
      const spend: SpendType = f.spendType;
      draft.spendType = spend;
      draft.spendAmountMinor =
        spend === "once" || spend === "monthly" ? toMinor(f.spendAmount, baseCurrency) : null;
      draft.spendRateBps = spend === "percent" ? fromPct(f.spendRate) : null;
      draft.spendStartKind = f.spendStartKind;
      draft.spendStartAge =
        spend !== "none" && f.spendStartKind === "age" ? parseInt(f.spendStartAge, 10) || 0 : null;
      draft.spendStartTargetMinor =
        spend !== "none" && f.spendStartKind === "target"
          ? toMinor(f.spendStartTarget, baseCurrency)
          : null;
    });
    await qc.invalidateQueries({ queryKey: ["networth"] });
    onClose();
  }

  const termMonths = joinTerm(loanTermYears, loanTermMonths);
  const paymentMinor = loanMonthlyPaymentMinor(
    account.balanceMinor,
    fromPct(loanRatePct),
    termMonths ?? 0,
  );

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex min-h-0 flex-1 flex-col">
      <ResponsiveDialogBody>
        <div className="flex flex-col gap-4">
          {isLiability ? (
            <div className="flex flex-col gap-4">
              <Field label={`Outstanding balance (${account.currency})`}>
                <Input
                  type="text"
                  value={fmtMajor(Math.abs(account.balanceMinor), account.currency)}
                  readOnly
                  disabled
                />
              </Field>
              <div className="grid grid-cols-3 gap-4">
                <Field label="Interest rate %/yr">
                  <Input type="number" step="any" min="0" {...register("loanRatePct")} />
                </Field>
                <Field label="Term (years)">
                  <Input type="number" min="0" placeholder="0" {...register("loanTermYears")} />
                </Field>
                <Field label="Term (months)">
                  <Input type="number" min="0" max="11" placeholder="0" {...register("loanTermMonths")} />
                </Field>
              </div>
              <Field label="Monthly payment (derived)">
                <Input
                  type="text"
                  value={termMonths ? fmtMajor(paymentMinor, account.currency) : "—"}
                  readOnly
                  disabled
                />
              </Field>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-4">
                <Field label="Annual growth %">
                  <Input type="number" step="any" {...register("growthPct")} />
                </Field>
                <Field label="Accessible from age">
                  <Input type="number" min="0" {...register("accessibleFromAge")} />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Before that age">
                  <Controller
                    control={control}
                    name="earlyWithdrawal"
                    render={({ field }) => (
                      <Select
                        value={field.value}
                        onValueChange={(v: string | null) =>
                          v && field.onChange(v as AccountRow["earlyWithdrawal"])
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
                    )}
                  />
                </Field>
                <Field label="Early penalty %">
                  <Input
                    type="number"
                    min="0"
                    step="any"
                    disabled={earlyWithdrawal !== "penalty"}
                    {...register("earlyHaircutPct")}
                  />
                </Field>
              </div>
              <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                <span className="text-sm">Illiquid (exclude from accessible)</span>
                <Controller
                  control={control}
                  name="illiquid"
                  render={({ field }) => (
                    <Switch checked={field.value} onCheckedChange={(v: boolean) => field.onChange(v)} />
                  )}
                />
              </div>
              {illiquid && (
                <Field label="Liquidation age (optional)">
                  <Input type="number" min="0" placeholder="never" {...register("liquidationAge")} />
                </Field>
              )}

              <div className="grid grid-cols-2 gap-4 border-t border-border pt-4">
                <Field label={`Monthly contribution (${baseCurrency})`}>
                  <Controller
                    control={control}
                    name="contribution"
                    render={({ field }) => (
                      <MoneyInput
                        currency={baseCurrency}
                        value={field.value}
                        onChange={field.onChange}
                        placeholder="0"
                      />
                    )}
                  />
                </Field>
                <Field label="Contribute until age">
                  <Input type="number" min="0" placeholder="no limit" {...register("contributionUntilAge")} />
                </Field>
                <Field label="Compound">
                  <Controller
                    control={control}
                    name="compoundInterval"
                    render={({ field }) => (
                      <Select
                        value={field.value}
                        onValueChange={(v: string | null) => v && field.onChange(v as CompoundInterval)}
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
                    )}
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-4 border-t border-border pt-4">
                <Field label="Withdrawal">
                  <Controller
                    control={control}
                    name="spendType"
                    render={({ field }) => (
                      <Select
                        value={field.value}
                        onValueChange={(v: string | null) => v && field.onChange(v as SpendType)}
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
                    )}
                  />
                </Field>

                {(spendType === "once" || spendType === "monthly") && (
                  <Field
                    label={spendType === "once" ? `Lump (${baseCurrency})` : `Per month (${baseCurrency})`}
                  >
                    <Controller
                      control={control}
                      name="spendAmount"
                      render={({ field }) => (
                        <MoneyInput currency={baseCurrency} value={field.value} onChange={field.onChange} />
                      )}
                    />
                  </Field>
                )}

                {spendType === "percent" && (
                  <Field label="Withdrawal rate (%/yr)">
                    <Input type="number" step="any" min="0" placeholder="4" {...register("spendRate")} />
                  </Field>
                )}

                {spendType !== "none" && (
                  <>
                    <Field label="Starts on">
                      <Controller
                        control={control}
                        name="spendStartKind"
                        render={({ field }) => (
                          <Select
                            value={field.value}
                            onValueChange={(v: string | null) => v && field.onChange(v as SpendStartKind)}
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
                        )}
                      />
                    </Field>
                    {spendStartKind === "age" ? (
                      <Field label="Start at age">
                        <Input type="number" min="0" {...register("spendStartAge")} />
                      </Field>
                    ) : (
                      <Field label={`Target balance (${baseCurrency})`}>
                        <Controller
                          control={control}
                          name="spendStartTarget"
                          render={({ field }) => (
                            <MoneyInput
                              currency={baseCurrency}
                              value={field.value}
                              onChange={field.onChange}
                            />
                          )}
                        />
                      </Field>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </ResponsiveDialogBody>
      <ResponsiveDialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit">Save</Button>
      </ResponsiveDialogFooter>
    </form>
  );
}
