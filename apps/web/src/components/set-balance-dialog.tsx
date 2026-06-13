import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { currencyDecimals } from "@uang/shared";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

interface Props {
  accountId: string;
  currency: string;
  mode: "set" | "revalue";
  onDone: () => void;
}

export function SetBalanceDialog({ accountId, currency, mode, onDone }: Props) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const major = parseFloat(amount);
    if (Number.isNaN(major)) return;
    const minor = Math.round(major * 10 ** currencyDecimals(currency));
    if (mode === "set") {
      await api.accounts({ id: accountId })["set-balance"].post({
        targetMinor: minor,
        date,
      });
    } else {
      await api.accounts({ id: accountId }).revalue.post({
        newValueMinor: minor,
        date,
      });
    }
    await qc.invalidateQueries();
    setOpen(false);
    setAmount("");
    onDone();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => setOpen(v)}>
      {/* DialogTrigger in @base-ui/react uses render prop instead of asChild */}
      <DialogTrigger
        render={
          <Button variant={mode === "set" ? "default" : "outline"} />
        }
      >
        {mode === "set" ? "Set balance…" : "Record revaluation…"}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {mode === "set" ? "Set current balance" : "Record revaluation"}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <Label>
              {mode === "set" ? "Balance" : "New value"} ({currency})
            </Label>
            <Input
              type="number"
              step="any"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
          </div>
          <div>
            <Label>As of date</Label>
            <Input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              required
            />
          </div>
          <DialogFooter>
            <Button type="submit">Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
