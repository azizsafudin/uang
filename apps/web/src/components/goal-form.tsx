import { useState } from "react";
import { currencyDecimals } from "@uang/shared";
import { goalsCollection, newId, type GoalRow } from "@/lib/collections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";

// major <-> minor helpers for the amount input.
const toMajor = (minor: number, currency: string) => String(minor / 10 ** currencyDecimals(currency));
const toMinor = (major: string, currency: string) =>
  Math.round((parseFloat(major) || 0) * 10 ** currencyDecimals(currency));

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
  const [f, setF] = useState({
    name: goal?.name ?? "",
    amount: goal ? toMajor(goal.targetAmountMinor, currency) : "",
    targetDate: goal?.targetDate ?? "",
    contribution: goal ? toMajor(goal.monthlyContributionMinor, currency) : "",
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const targetAmountMinor = toMinor(f.amount, currency);
    const monthlyContributionMinor = toMinor(f.contribution, currency);
    const targetDate = f.targetDate || null; // empty -> indefinite goal
    if (editing) {
      goalsCollection.update(goal!.id, (draft) => {
        draft.name = f.name;
        draft.targetAmountMinor = targetAmountMinor;
        draft.targetDate = targetDate;
        draft.monthlyContributionMinor = monthlyContributionMinor;
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
        spendType: "none" as const,
        spendAmountMinor: null,
        spendRateBps: null,
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
        <DialogTrigger render={<Button variant={editing ? "outline" : "default"} size="sm" />}>
          {editing ? "Edit" : "New goal"}
        </DialogTrigger>
      )}
      <DialogContent>
        <DialogHeader><DialogTitle>{editing ? "Edit goal" : "New goal"}</DialogTitle></DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <Label>Name</Label>
            <Input value={f.name} required onChange={(e) => setF((p) => ({ ...p, name: e.target.value }))} />
          </div>
          <div>
            <Label>Target ({currency})</Label>
            <Input type="number" step="any" value={f.amount} required
              onChange={(e) => setF((p) => ({ ...p, amount: e.target.value }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Target date <span className="text-muted-foreground">(optional)</span></Label>
              <Input type="date" value={f.targetDate}
                onChange={(e) => setF((p) => ({ ...p, targetDate: e.target.value }))} />
            </div>
            <div>
              <Label>Monthly contribution ({currency})</Label>
              <Input type="number" step="any" min="0" placeholder="0" value={f.contribution}
                onChange={(e) => setF((p) => ({ ...p, contribution: e.target.value }))} />
            </div>
          </div>
          <DialogFooter><Button type="submit">{editing ? "Save" : "Create"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
