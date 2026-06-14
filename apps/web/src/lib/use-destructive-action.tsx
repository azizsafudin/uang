import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

export type ConfirmOptions = {
  title: string;
  description?: string;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
};

// Reusable confirmation for destructive actions (delete, archive, reset, …).
// Usage:
//   const { confirm, dialog } = useDestructiveAction();
//   <button onClick={() => confirm({ title: "Delete goal?", onConfirm: () => collection.delete(id) })} />
//   {dialog}   // render once in the component tree
export function useDestructiveAction() {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const [busy, setBusy] = useState(false);

  const confirm = useCallback((options: ConfirmOptions) => setOpts(options), []);

  const close = useCallback(() => {
    if (!busy) setOpts(null);
  }, [busy]);

  async function run() {
    if (!opts) return;
    setBusy(true);
    try {
      await opts.onConfirm();
      setOpts(null);
    } finally {
      setBusy(false);
    }
  }

  const dialog = (
    <Dialog open={opts !== null} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{opts?.title ?? ""}</DialogTitle>
          {opts?.description && <DialogDescription>{opts.description}</DialogDescription>}
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={busy} />}>Cancel</DialogClose>
          <Button variant="destructive" disabled={busy} onClick={run}>
            {opts?.confirmLabel ?? "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { confirm, dialog };
}
