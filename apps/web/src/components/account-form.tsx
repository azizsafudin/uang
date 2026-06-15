import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { SUBTYPES, subtypeLabel, classLabel } from "@/components/labels";
import { accountsCollection, newId, type AccountRow } from "@/lib/collections";
import { defaultAssumptions } from "@/lib/assumptions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { useSession } from "@/lib/auth";
import { OwnersField } from "@/components/owners-field";
import { CurrencySelect } from "@/components/currency-select";
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

export function AccountForm({ defaultCurrency }: { defaultCurrency?: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({
    name: "",
    class: "asset",
    subtype: "bank",
    currency: defaultCurrency ?? "USD",
  });
  const set = (k: string, v: string) => setF((prev) => ({ ...prev, [k]: v }));

  const { data: session } = useSession();
  const meId = session?.user?.id;
  const [owners, setOwners] = useState<string[]>([]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const currency = f.currency.toUpperCase();
    const assumptions = defaultAssumptions(f.subtype);
    const row: AccountRow = {
      id: newId(),
      name: f.name,
      class: f.class as AccountRow["class"],
      subtype: f.subtype,
      currency,
      institution: null,
      isArchived: 0,
      sortOrder: 0,
      balanceMinor: 0,
      createdAt: Math.floor(Date.now() / 1000),
      createdBy: meId ?? "",
      groupId: null,
      ownerIds: owners.length > 0 ? owners : meId ? [meId] : [],
      growthRateBps: assumptions.growthRateBps,
      accessibleFromAge: assumptions.accessibleFromAge,
      earlyWithdrawal: assumptions.earlyWithdrawal,
      earlyHaircutBps: assumptions.earlyHaircutBps,
      illiquid: assumptions.illiquid ? 1 : 0,
      liquidationAge: assumptions.liquidationAge,
    };
    await accountsCollection.insert(row);
    await qc.invalidateQueries({ queryKey: ["networth"] });
    setOpen(false);
    setF((prev) => ({ ...prev, name: "" }));
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v && meId && owners.length === 0) setOwners([meId]);
        if (v && defaultCurrency) set("currency", defaultCurrency);
      }}
    >
      {/* DialogTrigger in @base-ui/react uses render prop instead of asChild */}
      <DialogTrigger render={<Button />}>Add account</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New account</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Name">
            <Input
              data-testid="account-name"
              value={f.name}
              onChange={(e) => set("name", e.target.value)}
              required
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Type" hint="Assets grow your net worth; Liabilities reduce it.">
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
            </Field>
            <Field label="Category" hint="The kind of account: bank account, investment portfolio, property, etc.">
              <Select
                value={f.subtype}
                onValueChange={(v: string | null) => {
                  if (!v) return;
                  set("subtype", v);
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
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Currency">
              <CurrencySelect
                data-testid="account-currency"
                value={f.currency}
                onValueChange={(code) => set("currency", code)}
              />
            </Field>
          </div>
          <Field label="Owners">
            <OwnersField value={owners} onChange={setOwners} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit">Create</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
