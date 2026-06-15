import { useEffect } from "react";
import { useForm, Controller } from "react-hook-form";
import { useQueryClient } from "@tanstack/react-query";
import { SUBTYPES, subtypeLabel, classLabel } from "@/components/labels";
import {
  accountsCollection,
  newId,
  type AccountRow,
  type GroupRow,
} from "@/lib/collections";
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
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type FormValues = {
  name: string;
  class: "asset" | "liability";
  subtype: string;
  currency: string;
  ownerIds: string[];
  groupId: string | null;
};

// Prefill payload for openers (section dot menu, group context menu).
export type AccountFormInitial = Partial<
  Pick<FormValues, "class" | "subtype" | "currency" | "ownerIds" | "groupId">
>;

const NO_GROUP = "__none__";

export function AccountForm({
  open,
  onOpenChange,
  initial,
  groups,
  defaultCurrency,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: AccountFormInitial;
  groups: GroupRow[];
  defaultCurrency?: string;
}) {
  const qc = useQueryClient();
  const { data: session } = useSession();
  const meId = session?.user?.id;

  const { register, handleSubmit, control, reset, setValue, watch } =
    useForm<FormValues>({
      defaultValues: {
        name: "",
        class: "asset",
        subtype: "bank",
        currency: defaultCurrency ?? "USD",
        ownerIds: meId ? [meId] : [],
        groupId: null,
      },
    });

  // Re-seed the form each time the dialog opens, applying any prefill.
  useEffect(() => {
    if (!open) return;
    reset({
      name: "",
      class: initial?.class ?? "asset",
      subtype: initial?.subtype ?? "bank",
      currency: (initial?.currency ?? defaultCurrency ?? "USD").toUpperCase(),
      ownerIds: initial?.ownerIds ?? (meId ? [meId] : []),
      groupId: initial?.groupId ?? null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const currentClass = watch("class");
  const groupOptions = groups.filter((g) => g.class === currentClass);

  async function onSubmit(values: FormValues) {
    const currency = values.currency.toUpperCase();
    const assumptions = defaultAssumptions(values.subtype);
    const row: AccountRow = {
      id: newId(),
      name: values.name,
      class: values.class,
      subtype: values.subtype,
      currency,
      institution: null,
      isArchived: 0,
      sortOrder: 0,
      balanceMinor: 0,
      createdAt: Math.floor(Date.now() / 1000),
      createdBy: meId ?? "",
      groupId: values.groupId,
      ownerIds: values.ownerIds.length > 0 ? values.ownerIds : meId ? [meId] : [],
      growthRateBps: assumptions.growthRateBps,
      accessibleFromAge: assumptions.accessibleFromAge,
      earlyWithdrawal: assumptions.earlyWithdrawal,
      earlyHaircutBps: assumptions.earlyHaircutBps,
      illiquid: assumptions.illiquid ? 1 : 0,
      liquidationAge: assumptions.liquidationAge,
      spendType: "none",
      spendAmountMinor: null,
      spendRateBps: null,
      spendStartKind: "age",
      spendStartAge: null,
      spendStartTargetMinor: null,
      contributionMinor: 0,
      contributionUntilAge: null,
      compoundInterval: "annually",
    };
    await accountsCollection.insert(row);
    await qc.invalidateQueries({ queryKey: ["networth"] });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New account</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <Field label="Name">
            <Input data-testid="account-name" {...register("name", { required: true })} />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Type" hint="Assets grow your net worth; Liabilities reduce it.">
              <Controller
                control={control}
                name="class"
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onValueChange={(v: string | null) => {
                      if (!v) return;
                      field.onChange(v);
                      // A group belongs to one class — clear it when class flips.
                      setValue("groupId", null);
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue>{(v: unknown) => classLabel(String(v))}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="asset">Asset</SelectItem>
                      <SelectItem value="liability">Liability</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
            <Field label="Category" hint="The kind of account: bank account, investment portfolio, property, etc.">
              <Controller
                control={control}
                name="subtype"
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onValueChange={(v: string | null) => v && field.onChange(v)}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue>{(v: unknown) => subtypeLabel(String(v))}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {SUBTYPES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {subtypeLabel(s)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Currency">
              <Controller
                control={control}
                name="currency"
                render={({ field }) => (
                  <CurrencySelect
                    data-testid="account-currency"
                    value={field.value}
                    onValueChange={(code) => field.onChange(code)}
                  />
                )}
              />
            </Field>
            <Field label="Group" hint="Optional — organise this account under a group.">
              <Controller
                control={control}
                name="groupId"
                render={({ field }) => (
                  <Select
                    value={field.value ?? NO_GROUP}
                    onValueChange={(v: string | null) =>
                      field.onChange(v === NO_GROUP || !v ? null : v)
                    }
                  >
                    <SelectTrigger className="w-full" data-testid="account-group">
                      <SelectValue>
                        {(v: unknown) => {
                          const id = String(v);
                          if (id === NO_GROUP) return "No group";
                          return groupOptions.find((g) => g.id === id)?.name ?? "No group";
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_GROUP}>No group</SelectItem>
                      {groupOptions.map((g) => (
                        <SelectItem key={g.id} value={g.id}>
                          {g.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
          </div>
          <Field label="Owners">
            <Controller
              control={control}
              name="ownerIds"
              render={({ field }) => (
                <OwnersField value={field.value} onChange={field.onChange} />
              )}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Create</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
