import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { currencyDecimals } from "@uang/shared";
import { SUBTYPES, subtypeLabel, classLabel } from "@/components/labels";
import { accountsCollection } from "@/lib/collections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSession } from "@/lib/auth";
import { OwnersField } from "@/components/owners-field";
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

export function AccountForm() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({
    name: "",
    class: "asset",
    subtype: "bank",
    currency: "USD",
    openingBalance: "",
    openingDate: new Date().toISOString().slice(0, 10),
  });
  const set = (k: string, v: string) => setF((prev) => ({ ...prev, [k]: v }));

  const { data: session } = useSession();
  const meId = session?.user?.id;
  const [owners, setOwners] = useState<string[]>([]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const openingMajor = parseFloat(f.openingBalance);
    const currency = f.currency.toUpperCase();
    const body: Record<string, unknown> = {
      name: f.name,
      class: f.class,
      subtype: f.subtype,
      currency,
      ownerIds: owners.length > 0 ? owners : meId ? [meId] : [],
    };
    if (!Number.isNaN(openingMajor) && openingMajor !== 0) {
      const dec = currencyDecimals(currency);
      body.openingBalanceMinor = Math.round(openingMajor * 10 ** dec);
      body.openingDate = f.openingDate;
    }
    await accountsCollection.insert(body as any);
    await qc.invalidateQueries({ queryKey: ["networth"] });
    setOpen(false);
    setF((prev) => ({ ...prev, name: "", openingBalance: "" }));
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v && meId && owners.length === 0) setOwners([meId]);
      }}
    >
      {/* DialogTrigger in @base-ui/react uses render prop instead of asChild */}
      <DialogTrigger render={<Button />}>Add account</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New account</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <Label>Name</Label>
            <Input
              value={f.name}
              onChange={(e) => set("name", e.target.value)}
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Type</Label>
              <Select
                value={f.class}
                onValueChange={(v: string | null) => v && set("class", v)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>
                    {(v: unknown) => classLabel(String(v))}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="asset">Asset</SelectItem>
                  <SelectItem value="liability">Liability</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Category</Label>
              <Select
                value={f.subtype}
                onValueChange={(v: string | null) => v && set("subtype", v)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>
                    {(v: unknown) => subtypeLabel(String(v))}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {SUBTYPES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {subtypeLabel(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Currency</Label>
              <Input
                value={f.currency}
                maxLength={3}
                onChange={(e) => set("currency", e.target.value)}
                required
              />
            </div>
            <div>
              <Label>Opening balance</Label>
              <Input
                type="number"
                step="any"
                value={f.openingBalance}
                onChange={(e) => set("openingBalance", e.target.value)}
                placeholder="optional"
              />
            </div>
          </div>
          <div>
            <Label>Opening date</Label>
            <Input
              type="date"
              value={f.openingDate}
              onChange={(e) => set("openingDate", e.target.value)}
            />
          </div>
          <div>
            <Label>Owners</Label>
            <OwnersField value={owners} onChange={setOwners} />
          </div>
          <DialogFooter>
            <Button type="submit">Create</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
