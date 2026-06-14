import { useState } from "react";
import { currencyDecimals } from "@uang/shared";
import { goalsCollection, newId, type GoalRow } from "@/lib/collections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

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
    term: goal?.term ?? ("long" as "short" | "long"),
    amount: goal ? toMajor(goal.targetAmountMinor, currency) : "",
    targetDate: goal?.targetDate ?? "",
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const targetAmountMinor = toMinor(f.amount, currency);
    if (editing) {
      goalsCollection.update(goal!.id, (draft) => {
        draft.name = f.name;
        draft.term = f.term;
        draft.targetAmountMinor = targetAmountMinor;
        draft.targetDate = f.targetDate;
      });
    } else {
      goalsCollection.insert({
        id: newId(),
        name: f.name,
        term: f.term,
        targetAmountMinor,
        currency,
        targetDate: f.targetDate,
        ownerScope: "household",
        anchorDate: null,
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
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Term</Label>
              <Select value={f.term}
                onValueChange={(v: string | null) => v && setF((p) => ({ ...p, term: v as "short" | "long" }))}>
                <SelectTrigger className="w-full">
                  <SelectValue>{(v: unknown) => (String(v) === "short" ? "Short term" : "Long term")}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="short">Short term</SelectItem>
                  <SelectItem value="long">Long term</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Target ({currency})</Label>
              <Input type="number" step="any" value={f.amount} required
                onChange={(e) => setF((p) => ({ ...p, amount: e.target.value }))} />
            </div>
          </div>
          <div>
            <Label>Target date</Label>
            <Input type="date" value={f.targetDate} required
              onChange={(e) => setF((p) => ({ ...p, targetDate: e.target.value }))} />
          </div>
          <DialogFooter><Button type="submit">{editing ? "Save" : "Create"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
