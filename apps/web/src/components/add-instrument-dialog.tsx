import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { instrumentsCollection } from "@/lib/collections";
import { Button } from "@/components/ui/button";
import { NewInstrumentForm, type NewInstrumentSpec } from "@/components/new-instrument-form";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger,
} from "@/components/ui/responsive-dialog";

export function AddInstrumentDialog({ defaultCurrency }: { defaultCurrency: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [spec, setSpec] = useState<NewInstrumentSpec | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function add() {
    if (!spec) return;
    setBusy(true); setErr("");
    const { data, error } = await api.instruments.post({
      name: spec.name, kind: spec.kind, currency: spec.currency,
      symbol: spec.symbol ?? undefined, isin: spec.isin ?? undefined,
    });
    if (error || !data || !("id" in data) || !data.id) {
      setBusy(false);
      setErr(String(error) === "[object Object]" ? "Couldn't add instrument." : "An instrument with this symbol already exists.");
      return;
    }
    // Looked-up instruments: pull an initial provider price so they don't show "—".
    if (spec.symbol || spec.isin) {
      await api["market-data"].instrument({ id: data.id }).refresh.post({ backfill: true });
    }
    await instrumentsCollection.utils.refetch();
    await qc.invalidateQueries({ queryKey: ["instruments"] });
    await qc.invalidateQueries({ queryKey: ["networth"] });
    await qc.invalidateQueries({ queryKey: ["holdings"] });
    setBusy(false);
    setOpen(false);
    setSpec(null);
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setSpec(null); setErr(""); } }}>
      <ResponsiveDialogTrigger render={<Button variant="outline" size="sm" data-testid="add-instrument" />}>
        Add instrument
      </ResponsiveDialogTrigger>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Add instrument</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="space-y-3">
          <NewInstrumentForm defaultCurrency={defaultCurrency} onResolved={setSpec} />
          {err && <p className="text-sm text-destructive">{err}</p>}
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button type="button" data-testid="add-instrument-submit" disabled={!spec || busy} onClick={add}>
            {busy ? "Adding…" : "Add instrument"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
