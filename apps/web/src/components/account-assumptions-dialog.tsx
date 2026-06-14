import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { accountsCollection, type AccountRow } from "@/lib/collections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// bps <-> percent helpers (UI shows percent; storage is basis points).
const toPct = (bps: number) => String(bps / 100);
const fromPct = (s: string) => Math.round((parseFloat(s) || 0) * 100);

function seedForm(account: AccountRow) {
  return {
    growthPct: toPct(account.growthRateBps),
    accessibleFromAge: String(account.accessibleFromAge),
    earlyWithdrawal: account.earlyWithdrawal,
    earlyHaircutPct: toPct(account.earlyHaircutBps),
    illiquid: account.illiquid === 1,
    liquidationAge: account.liquidationAge == null ? "" : String(account.liquidationAge),
  };
}

export function AccountAssumptionsDialog({ account }: { account: AccountRow }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(() => seedForm(account));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    accountsCollection.update(account.id, (draft) => {
      draft.growthRateBps = fromPct(f.growthPct);
      draft.accessibleFromAge = parseInt(f.accessibleFromAge, 10) || 0;
      draft.earlyWithdrawal = f.earlyWithdrawal;
      draft.earlyHaircutBps = fromPct(f.earlyHaircutPct);
      draft.illiquid = f.illiquid ? 1 : 0;
      draft.liquidationAge = f.liquidationAge === "" ? null : parseInt(f.liquidationAge, 10);
    });
    await qc.invalidateQueries({ queryKey: ["networth"] });
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (v) setF(seedForm(account)); setOpen(v); }}>
      <DialogTrigger render={<Button variant="outline" />}>Edit assumptions</DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Projection assumptions</DialogTitle></DialogHeader>
        <form onSubmit={save} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Annual growth %</Label>
              <Input type="number" step="any" value={f.growthPct}
                onChange={(e) => setF((p) => ({ ...p, growthPct: e.target.value }))} />
            </div>
            <div>
              <Label>Accessible from age</Label>
              <Input type="number" min="0" value={f.accessibleFromAge}
                onChange={(e) => setF((p) => ({ ...p, accessibleFromAge: e.target.value }))} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Before that age</Label>
              <Select value={f.earlyWithdrawal}
                onValueChange={(v: string | null) => v && setF((p) => ({ ...p, earlyWithdrawal: v as AccountRow["earlyWithdrawal"] }))}>
                <SelectTrigger className="w-full">
                  <SelectValue>{(v: unknown) => (String(v) === "penalty" ? "Withdraw with penalty" : "Locked")}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Locked</SelectItem>
                  <SelectItem value="penalty">Withdraw with penalty</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Early penalty %</Label>
              <Input type="number" min="0" step="any" value={f.earlyHaircutPct}
                disabled={f.earlyWithdrawal !== "penalty"}
                onChange={(e) => setF((p) => ({ ...p, earlyHaircutPct: e.target.value }))} />
            </div>
          </div>
          <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
            <Label>Illiquid (exclude from accessible)</Label>
            <Switch checked={f.illiquid} onCheckedChange={(v: boolean) => setF((p) => ({ ...p, illiquid: v }))} />
          </div>
          {f.illiquid && (
            <div>
              <Label>Liquidation age (optional)</Label>
              <Input type="number" min="0" value={f.liquidationAge} placeholder="never"
                onChange={(e) => setF((p) => ({ ...p, liquidationAge: e.target.value }))} />
            </div>
          )}
          <DialogFooter><Button type="submit">Save</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
