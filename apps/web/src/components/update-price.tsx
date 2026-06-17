import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useQueryClient } from "@tanstack/react-query";
import { SCALE } from "@uang/shared";
import { pricesCollection, newId } from "@/lib/collections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger,
} from "@/components/ui/responsive-dialog";

type FormValues = { price: string; date: string };

const today = () => new Date().toISOString().slice(0, 10);

// Set a manual price for an instrument at a date (default today). Upserts per (instrument, date).
export function UpdatePrice({
  instrumentId,
  accountId,
  label,
}: {
  instrumentId: string;
  accountId?: string;
  label?: string;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { register, handleSubmit, reset } = useForm<FormValues>({
    defaultValues: { price: "", date: today() },
  });

  useEffect(() => {
    if (open) reset({ price: "", date: today() });
  }, [open, reset]);

  async function onSubmit(values: FormValues) {
    const p = parseFloat(values.price);
    if (Number.isNaN(p)) return;
    await pricesCollection(instrumentId).insert({
      id: newId(),
      instrumentId,
      date: values.date,
      priceScaled: Math.round(p * Number(SCALE)),
      source: "manual",
      createdAt: Math.floor(Date.now() / 1000),
    });
    if (accountId) await qc.invalidateQueries({ queryKey: ["positions", accountId] });
    await qc.invalidateQueries({ queryKey: ["networth"] });
    await qc.invalidateQueries({ queryKey: ["holdings"] });
    await qc.invalidateQueries({ queryKey: ["instrument", instrumentId] });
    setOpen(false);
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={setOpen}>
      <ResponsiveDialogTrigger render={<Button variant="ghost" size="sm" />}>
        {label ?? "Update price"}
      </ResponsiveDialogTrigger>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Update price</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="flex min-h-0 flex-1 flex-col">
          <ResponsiveDialogBody className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <Field label="Price">
                <Input
                  data-testid="price-amount"
                  type="number"
                  step="any"
                  required
                  {...register("price", { required: true })}
                />
              </Field>
              <Field label="As of date">
                <Input
                  data-testid="price-date"
                  type="date"
                  required
                  {...register("date", { required: true })}
                />
              </Field>
            </div>
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit">Save price</Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
