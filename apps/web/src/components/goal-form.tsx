import { useState } from "react";
import { currencyDecimals } from "@uang/shared";
import { goalsCollection, newId, type GoalRow } from "@/lib/collections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";

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
  const [f, setF] = useState({
    name: goal?.name ?? "",
    amount: goal ? toMajor(goal.targetAmountMinor, currency) : "",
    targetDate: goal?.targetDate ?? "",
    contribution: goal ? toMajor(goal.monthlyContributionMinor, currency) : "",
    spendType: (goal?.spendType ?? "none") as SpendType,
    spendAmount: goal?.spendAmountMinor != null ? toMajor(goal.spendAmountMinor, currency) : "",
    spendRate: goal?.spendRateBps != null ? String(goal.spendRateBps / 100) : "", // bps -> percent
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const targetAmountMinor = toMinor(f.amount, currency);
    const monthlyContributionMinor = toMinor(f.contribution, currency);
    const targetDate = f.targetDate || null; // empty -> indefinite goal

    // A spending goal needs a target date (spend starts there).
    if (f.spendType !== "none" && !targetDate) {
      setError("A spending goal needs a target date.");
      return;
    }
    setError(null);

    // Only the relevant spend field is persisted; the other is null.
    const spendAmountMinor =
      f.spendType === "once" || f.spendType === "monthly" ? toMinor(f.spendAmount, currency) : null;
    const spendRateBps =
      f.spendType === "percent" ? Math.round((parseFloat(f.spendRate) || 0) * 100) : null;

    if (editing) {
      goalsCollection.update(goal!.id, (draft) => {
        draft.name = f.name;
        draft.targetAmountMinor = targetAmountMinor;
        draft.targetDate = targetDate;
        draft.monthlyContributionMinor = monthlyContributionMinor;
        draft.spendType = f.spendType;
        draft.spendAmountMinor = spendAmountMinor;
        draft.spendRateBps = spendRateBps;
      });
    } else {
      goalsCollection.insert({
        id: newId(),
        name: f.name,
        targetAmountMinor,
        currency,
        targetDate,
        ownerScope: "household",
        anchorDate: null,
        monthlyContributionMinor,
        spendType: f.spendType,
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
    <Dialog open={open} onOpenChange={setOpen}>
      {!hideTrigger && (
        <DialogTrigger render={<Button variant={editing ? "outline" : "default"} />}>
          {editing ? "Edit" : "New goal"}
        </DialogTrigger>
      )}
      <DialogContent>
        <DialogHeader><DialogTitle>{editing ? "Edit goal" : "New goal"}</DialogTitle></DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Name">
            <Input value={f.name} required onChange={(e) => setF((p) => ({ ...p, name: e.target.value }))} />
          </Field>
          <Field label={`Target (${currency})`}>
            <Input type="number" step="any" value={f.amount} required
              onChange={(e) => setF((p) => ({ ...p, amount: e.target.value }))} />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label={<>Target date <span className="text-muted-foreground">(optional)</span></>}>
              <Input type="date" value={f.targetDate}
                onChange={(e) => setF((p) => ({ ...p, targetDate: e.target.value }))} />
            </Field>
            <Field label={`Monthly contribution (${currency})`}>
              <Input type="number" step="any" min="0" placeholder="0" value={f.contribution}
                onChange={(e) => setF((p) => ({ ...p, contribution: e.target.value }))} />
            </Field>
          </div>

          {/* Spend / decumulation: how this goal spends at/after its target date. */}
          <div className="grid grid-cols-2 gap-4 border-t border-border/70 pt-4">
            <Field label="Spend">
              <Select
                value={f.spendType}
                onValueChange={(v) => setF((p) => ({ ...p, spendType: v as SpendType }))}
              >
                <SelectTrigger>
                  <SelectValue>{(v: unknown) => SPEND_LABELS[String(v) as SpendType] ?? String(v)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(SPEND_LABELS) as SpendType[]).map((k) => (
                    <SelectItem key={k} value={k}>{SPEND_LABELS[k]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {(f.spendType === "once" || f.spendType === "monthly") && (
              <Field label={f.spendType === "once" ? `Lump (${currency})` : `Per month (${currency})`}>
                <Input type="number" step="any" min="0" value={f.spendAmount}
                  onChange={(e) => setF((p) => ({ ...p, spendAmount: e.target.value }))} />
              </Field>
            )}
            {f.spendType === "percent" && (
              <Field label="Withdrawal rate (%/yr)">
                <Input type="number" step="any" min="0" placeholder="4" value={f.spendRate}
                  onChange={(e) => setF((p) => ({ ...p, spendRate: e.target.value }))} />
              </Field>
            )}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit">{editing ? "Save" : "Create"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
