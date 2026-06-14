import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { SCALE } from "@uang/shared";
import { pricesCollection, newId } from "@/lib/collections";
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

// Set a manual price for an instrument at a date (default today). Upserts per (instrument, date).
export function UpdatePrice({
  instrumentId,
  accountId,
  label,
}: {
  instrumentId: string;
  accountId: string;
  label?: string;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [price, setPrice] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const p = parseFloat(price);
    if (Number.isNaN(p)) return;
    await pricesCollection(instrumentId).insert({
      id: newId(),
      instrumentId,
      date,
      priceScaled: Math.round(p * Number(SCALE)),
      source: "manual",
      createdAt: Math.floor(Date.now() / 1000),
    });
    await qc.invalidateQueries({ queryKey: ["holdings", accountId] });
    await qc.invalidateQueries({ queryKey: ["networth"] });
    setOpen(false);
    setPrice("");
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>{label ?? "Update price"}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update price</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Price</Label>
              <Input type="number" step="any" value={price} onChange={(e) => setPrice(e.target.value)} required />
            </div>
            <div>
              <Label>As of date</Label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
            </div>
          </div>
          <DialogFooter>
            <Button type="submit">Save price</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
