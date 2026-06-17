import { useEffect } from "react";
import { useForm, Controller } from "react-hook-form";
import { useQueryClient } from "@tanstack/react-query";
import { currencyDecimals, loanMonthlyPaymentMinor } from "@uang/shared";
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
import {
  ResponsiveDialogBody,
  ResponsiveDialogFooter,
} from "@/components/ui/responsive-dialog";
import { Field } from "@/components/account-info-card";

// UI shows percent; storage is basis points.
const toPct = (bps: number) => String(bps / 100);
const fromPct = (s: string) => Math.round((parseFloat(s) || 0) * 100);

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

type CompoundInterval = AccountRow["compoundInterval"];

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
  compoundInterval: CompoundInterval;
  loanRatePct: string;
  loanTermYears: string;
  loanTermMonths: string;
};

function seedForm(account: AccountRow): FormValues {
  return {
    growthPct: toPct(account.growthRateBps),
    accessibleFromAge: String(account.accessibleFromAge),
    earlyWithdrawal: account.earlyWithdrawal,
    earlyHaircutPct: toPct(account.earlyHaircutBps),
    illiquid: account.illiquid === 1,
    liquidationAge: account.liquidationAge == null ? "" : String(account.liquidationAge),
    compoundInterval: account.compoundInterval,
    loanRatePct: toPct(account.growthRateBps),
    loanTermYears: splitTerm(account.loanTermMonths).years,
    loanTermMonths: splitTerm(account.loanTermMonths).months,
  };
}

// The projection assumptions editor for one account (vessel-only: growth,
// accessibility, compound interval, and loan terms for liabilities).
// Rendered inside the edit dialog on /projections.
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
    defaultValues: seedForm(account),
  });

  useEffect(() => {
    reset(seedForm(account));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id]);

  const earlyWithdrawal = watch("earlyWithdrawal");
  const illiquid = watch("illiquid");
  const loanRatePct = watch("loanRatePct");
  const loanTermYears = watch("loanTermYears");
  const loanTermMonths = watch("loanTermMonths");

  async function onSubmit(f: FormValues) {
    accountsCollection.update(account.id, (draft) => {
      if (isLiability) {
        // Single loan model: interest rate + remaining term. Balance comes from
        // transactions; accessibility/contribution are not used.
        draft.growthRateBps = fromPct(f.loanRatePct);
        draft.loanTermMonths = joinTerm(f.loanTermYears, f.loanTermMonths);
        return;
      }
      draft.growthRateBps = fromPct(f.growthPct);
      draft.accessibleFromAge = parseInt(f.accessibleFromAge, 10) || 0;
      draft.earlyWithdrawal = f.earlyWithdrawal;
      draft.earlyHaircutBps = fromPct(f.earlyHaircutPct);
      draft.illiquid = f.illiquid ? 1 : 0;
      draft.liquidationAge = f.liquidationAge === "" ? null : parseInt(f.liquidationAge, 10);
      draft.compoundInterval = f.compoundInterval;
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
              <div className="grid grid-cols-2 gap-4">
                <Field label="Accessible from age">
                  <Input type="number" min="0" {...register("accessibleFromAge")} />
                </Field>
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
              </div>
              {earlyWithdrawal === "penalty" && (
                <Field label="Early penalty %">
                  <Input
                    type="number"
                    min="0"
                    step="any"
                    {...register("earlyHaircutPct")}
                  />
                </Field>
              )}
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
