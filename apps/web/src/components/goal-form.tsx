import { useEffect, useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { useLiveQuery } from "@tanstack/react-db";
import { useQueryClient } from "@tanstack/react-query";
import { currencyDecimals } from "@uang/shared";
import { goalsCollection, newId, type GoalRow, accountsCollection } from "@/lib/collections";
import { useUsers } from "@/lib/use-users";
import { api } from "@/lib/api";
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
  const qc = useQueryClient();
  const currency = goal?.currency ?? defaultCurrency;
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = onOpenChange ?? setOpenState;
  const [error, setError] = useState<string | null>(null);

  const { data: accounts = [] } = useLiveQuery(accountsCollection);
  const eligible = accounts.filter((a) => a.class === "asset" && a.isArchived === 0);
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [contributionAccountId, setContributionAccountId] = useState<string | null>(null);

  // Group the eligible accounts by owner set (e.g. "Aziz", "Jihan", "Aziz & Jihan"),
  // matching how accounts are organised elsewhere. First-seen order is preserved.
  const { data: users } = useUsers();
  const nameById = new Map((users ?? []).map((u) => [u.id, u.name] as const));
  const ownerLabel = (ids: string[]) =>
    ids.length === 0 ? "Unassigned" : ids.map((id) => nameById.get(id) ?? "Unknown").join(" & ");
  const ownerGroups: { label: string; accounts: typeof eligible }[] = [];
  for (const a of eligible) {
    const label = ownerLabel(a.ownerIds);
    let g = ownerGroups.find((x) => x.label === label);
    if (!g) { g = { label, accounts: [] }; ownerGroups.push(g); }
    g.accounts.push(a);
  }

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
      if (goal) {
        setContributionAccountId(goal.contributionAccountId ?? null);
        api.goals.analysis.get().then(({ data }) => {
          const row = (data as unknown as { goals: Array<{ id: string; accountIds: string[] }> } | null)
            ?.goals.find((g) => g.id === goal.id);
          setAccountIds(row?.accountIds ?? []);
        });
      } else {
        setAccountIds([]);
        setContributionAccountId(null);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const spendType = watch("spendType");

  async function onSubmit(values: FormValues) {
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

    const goalId = editing ? goal!.id : newId();

    if (editing) {
      goalsCollection.update(goal!.id, (draft) => {
        draft.name = values.name;
        draft.targetAmountMinor = targetAmountMinor;
        draft.targetDate = targetDate;
        draft.monthlyContributionMinor = monthlyContributionMinor;
        draft.contributionAccountId = contributionAccountId;
        draft.spendType = values.spendType;
        draft.spendAmountMinor = spendAmountMinor;
        draft.spendRateBps = spendRateBps;
      });
    } else {
      goalsCollection.insert({
        id: goalId,
        name: values.name,
        targetAmountMinor,
        currency,
        targetDate,
        ownerScope: "household",
        anchorDate: null,
        monthlyContributionMinor,
        contributionAccountId,
        spendType: values.spendType,
        spendAmountMinor,
        spendRateBps,
        sortOrder: 0,
        createdAt: Math.floor(Date.now() / 1000),
        createdBy: "",
      });
    }
    await api.goals({ id: goalId }).accounts.put({ accountIds });
    // Funding-set / contribution-account edits don't change the goal's scalar
    // signature, so force the analysis (donut sources + chart flows) to refetch.
    await qc.invalidateQueries({ queryKey: ["goals", "analysis"] });
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

            <div className="space-y-2 border-t border-border/70 pt-4">
              <Field label="Funded by">
                <div className="flex flex-col gap-2.5">
                  {eligible.length === 0 && (
                    <p className="text-sm text-muted-foreground">No asset accounts yet.</p>
                  )}
                  {ownerGroups.map((group) => (
                    <div key={group.label} className="flex flex-col gap-1.5">
                      {ownerGroups.length > 1 && (
                        <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                          {group.label}
                        </span>
                      )}
                      {group.accounts.map((a) => {
                        const checked = accountIds.includes(a.id);
                        return (
                          <label key={a.id} className="flex items-center gap-2 text-sm" data-testid={`assign-${a.id}`}>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => {
                                setAccountIds((prev) => {
                                  const next = e.target.checked ? [...prev, a.id] : prev.filter((id) => id !== a.id);
                                  if (!next.includes(contributionAccountId ?? "")) setContributionAccountId(next[0] ?? null);
                                  return next;
                                });
                              }}
                            />
                            <span>{a.name}</span>
                          </label>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </Field>
              {accountIds.length > 0 && (
                <Field label="Monthly contribution lands in">
                  <Select value={contributionAccountId ?? accountIds[0]} onValueChange={(v) => v && setContributionAccountId(v)}>
                    <SelectTrigger>
                      <SelectValue>{(v: unknown) => eligible.find((a) => a.id === String(v))?.name ?? "—"}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {accountIds.map((id) => (
                        <SelectItem key={id} value={id}>{eligible.find((a) => a.id === id)?.name ?? id}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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
