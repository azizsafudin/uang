import { useEffect, useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { currencyDecimals } from "@uang/shared";
import { goalsCollection, newId, type GoalRow } from "@/lib/collections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import { Field } from "@/components/ui/field";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger,
} from "@/components/ui/responsive-dialog";

// major <-> minor helpers for the amount inputs.
const toMajor = (minor: number, currency: string) => String(minor / 10 ** currencyDecimals(currency));
const toMinor = (major: string, currency: string) =>
  Math.round((parseFloat(major) || 0) * 10 ** currencyDecimals(currency));

type SpendType = "none" | "once" | "monthly" | "percent";

const SPEND_LABELS: Record<SpendType, string> = {
  none: "None (save only)",
  once: "One-time spend",
  monthly: "Monthly income",
  percent: "% of balance / yr",
};

type FormValues = {
  name: string;
  amount: string;
  targetDate: string;
  contribution: string;
  spendType: SpendType;
  spendAmount: string;
  spendRate: string;
};

export function GoalForm({
  goal,
  defaultCurrency = "USD",
  open: openProp,
  onOpenChange,
  hideTrigger = false,
}: {
  goal?: GoalRow;
  defaultCurrency?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
}) {
  const editing = !!goal;
  const currency = goal?.currency ?? defaultCurrency;
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = onOpenChange ?? setOpenState;
  const [error, setError] = useState<string | null>(null);

  const defaults = (): FormValues => ({
    name: goal?.name ?? "",
    amount: goal ? toMajor(goal.targetAmountMinor, currency) : "",
    targetDate: goal?.targetDate ?? "",
    contribution: goal ? toMajor(goal.monthlyContributionMinor, currency) : "",
    spendType: goal?.spendType ?? "none",
    spendAmount: goal?.spendAmountMinor != null ? toMajor(goal.spendAmountMinor, currency) : "",
    spendRate: goal?.spendRateBps != null ? String(goal.spendRateBps / 100) : "", // bps -> percent
  });

  const { register, handleSubmit, control, watch, reset } = useForm<FormValues>({
    defaultValues: defaults(),
  });

  // Re-seed the form each time the dialog opens.
  useEffect(() => {
    if (open) {
      reset(defaults());
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const spendType = watch("spendType");

  function onSubmit(values: FormValues) {
    const targetAmountMinor = toMinor(values.amount, currency);
    const monthlyContributionMinor = toMinor(values.contribution, currency);
    const targetDate = values.targetDate || null; // empty -> indefinite goal

    // A spending goal needs a target date (spend starts there).
    if (values.spendType !== "none" && !targetDate) {
      setError("A spending goal needs a target date.");
      return;
    }
    setError(null);

    // Only the relevant spend field is persisted; the other is null.
    const spendAmountMinor =
      values.spendType === "once" || values.spendType === "monthly"
        ? toMinor(values.spendAmount, currency)
        : null;
    const spendRateBps =
      values.spendType === "percent" ? Math.round((parseFloat(values.spendRate) || 0) * 100) : null;

    if (editing) {
      goalsCollection.update(goal!.id, (draft) => {
        draft.name = values.name;
        draft.targetAmountMinor = targetAmountMinor;
        draft.targetDate = targetDate;
        draft.monthlyContributionMinor = monthlyContributionMinor;
        draft.spendType = values.spendType;
        draft.spendAmountMinor = spendAmountMinor;
        draft.spendRateBps = spendRateBps;
      });
    } else {
      goalsCollection.insert({
        id: newId(),
        name: values.name,
        targetAmountMinor,
        currency,
        targetDate,
        ownerScope: "household",
        anchorDate: null,
        monthlyContributionMinor,
        contributionAccountId: null,
        spendType: values.spendType,
        spendAmountMinor,
        spendRateBps,
        sortOrder: 0,
        createdAt: Math.floor(Date.now() / 1000),
        createdBy: "",
      });
    }
    setOpen(false);
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={setOpen}>
      {!hideTrigger && (
        <ResponsiveDialogTrigger render={<Button variant={editing ? "outline" : "default"} />}>
          {editing ? "Edit" : "New goal"}
        </ResponsiveDialogTrigger>
      )}
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{editing ? "Edit goal" : "New goal"}</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="flex min-h-0 flex-1 flex-col">
          <ResponsiveDialogBody className="space-y-4">
            <Field label="Name">
              <Input required {...register("name", { required: true })} />
            </Field>
            <Field label={`Target (${currency})`}>
              <Controller
                control={control}
                name="amount"
                rules={{ required: true }}
                render={({ field }) => (
                  <MoneyInput currency={currency} value={field.value} onChange={field.onChange} required />
                )}
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label={<>Target date <span className="text-muted-foreground">(optional)</span></>}>
                <Input type="date" {...register("targetDate")} />
              </Field>
              <Field label={`Monthly contribution (${currency})`}>
                <Controller
                  control={control}
                  name="contribution"
                  render={({ field }) => (
                    <MoneyInput currency={currency} value={field.value} onChange={field.onChange} placeholder="0" />
                  )}
                />
              </Field>
            </div>

            {/* Spend / decumulation: how this goal spends at/after its target date. */}
            <div className="grid grid-cols-2 gap-4 border-t border-border/70 pt-4">
              <Field label="Spend">
                <Controller
                  control={control}
                  name="spendType"
                  render={({ field }) => (
                    <Select
                      value={field.value}
                      onValueChange={(v) => v && field.onChange(v as SpendType)}
                    >
                      <SelectTrigger>
                        <SelectValue>
                          {(v: unknown) => SPEND_LABELS[String(v) as SpendType] ?? String(v)}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(SPEND_LABELS) as SpendType[]).map((k) => (
                          <SelectItem key={k} value={k}>{SPEND_LABELS[k]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </Field>
              {(spendType === "once" || spendType === "monthly") && (
                <Field label={spendType === "once" ? `Lump (${currency})` : `Per month (${currency})`}>
                  <Controller
                    control={control}
                    name="spendAmount"
                    render={({ field }) => (
                      <MoneyInput currency={currency} value={field.value} onChange={field.onChange} />
                    )}
                  />
                </Field>
              )}
              {spendType === "percent" && (
                <Field label="Withdrawal rate (%/yr)">
                  <Input type="number" step="any" min="0" placeholder="4" {...register("spendRate")} />
                </Field>
              )}
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </ResponsiveDialogBody>

          <ResponsiveDialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit">{editing ? "Save" : "Create"}</Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
