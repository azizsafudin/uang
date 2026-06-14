import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { currencyDecimals } from "@uang/shared";
import { SUBTYPES, subtypeLabel, classLabel } from "@/components/labels";
import { accountsCollection, newId, type AccountRow } from "@/lib/collections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSession } from "@/lib/auth";
import { OwnersField } from "@/components/owners-field";
import { FieldTooltip } from "@/components/field-tooltip";
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
    valuationMode: "ledger",
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
    // A complete optimistic row; the server fills balanceMinor/createdAt/createdBy
    // and reconciles by id on refetch.
    const row: AccountRow = {
      id: newId(),
      name: f.name,
      class: f.class as AccountRow["class"],
      subtype: f.subtype,
      currency,
      valuationMode: f.valuationMode as AccountRow["valuationMode"],
      institution: null,
      isArchived: 0,
      sortOrder: 0,
      balanceMinor: 0,
      createdAt: Math.floor(Date.now() / 1000),
      createdBy: meId ?? "",
      ownerIds: owners.length > 0 ? owners : meId ? [meId] : [],
    };
    if (f.valuationMode === "ledger" && !Number.isNaN(openingMajor) && openingMajor !== 0) {
      const dec = currencyDecimals(currency);
      row.openingBalanceMinor = Math.round(openingMajor * 10 ** dec);
      row.openingDate = f.openingDate;
    }
    await accountsCollection.insert(row);
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
              data-testid="account-name"
              value={f.name}
              onChange={(e) => set("name", e.target.value)}
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="inline-flex items-center">
                Type
                <FieldTooltip content="Asset = something you own; Liability = a debt or obligation" />
              </Label>
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
              <Label className="inline-flex items-center">
                Category
                <FieldTooltip content="How this account is categorised on the dashboard" />
              </Label>
              <Select
                value={f.subtype}
                onValueChange={(v: string | null) => {
                  if (!v) return;
                  setF((prev) => ({
                    ...prev,
                    subtype: v,
                    valuationMode: v === "investment" ? "holdings" : "ledger",
                  }));
                }}
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
          <div>
            <Label className="inline-flex items-center">
              Valuation
              <FieldTooltip content="Ledger: you record the balance manually from your statement. Holdings: value is calculated from your investment positions (units × current price)" />
            </Label>
            <Select
              value={f.valuationMode}
              onValueChange={(v: string | null) => v && set("valuationMode", v)}
            >
              <SelectTrigger className="w-full" data-testid="account-valuation">
                <SelectValue>
                  {(v: unknown) => (String(v) === "holdings" ? "Holdings (investments)" : "Ledger (balance)")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ledger">Ledger (balance)</SelectItem>
                <SelectItem value="holdings">Holdings (investments)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="inline-flex items-center">
                Currency
                <FieldTooltip content="3-letter ISO code, e.g. SGD, USD, MYR" />
              </Label>
              <Input
                data-testid="account-currency"
                value={f.currency}
                maxLength={3}
                onChange={(e) => set("currency", e.target.value)}
                required
              />
            </div>
            {f.valuationMode === "ledger" && (
              <div>
                <Label>Opening balance</Label>
                <Input
                  data-testid="account-opening"
                  type="number"
                  step="any"
                  value={f.openingBalance}
                  onChange={(e) => set("openingBalance", e.target.value)}
                  placeholder="optional"
                />
              </div>
            )}
          </div>
          {f.valuationMode === "ledger" && (
            <div>
              <Label>Opening date</Label>
              <Input
                type="date"
                value={f.openingDate}
                onChange={(e) => set("openingDate", e.target.value)}
              />
            </div>
          )}
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
