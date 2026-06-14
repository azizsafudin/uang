import { useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { formatMoney } from "@/components/money";
import { subtypeLabel, classLabel, kindLabel } from "@/components/labels";
import { SetBalanceDialog } from "@/components/set-balance-dialog";
import { AppShell, Eyebrow } from "@/components/app-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { accountsCollection, entriesCollection } from "@/lib/collections";
import { AccountInfoCard } from "@/components/account-info-card";
import { AccountAssumptionsDialog } from "@/components/account-assumptions-dialog";
import { HoldingsDetail } from "@/components/holdings-detail";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

const BackButton = () => (
  <Link to="/">
    <Button variant="ghost" size="sm">
      ← Back
    </Button>
  </Link>
);

export function AccountDetailPage() {
  const { id } = useParams({ from: "/accounts/$id" });
  const nav = useNavigate();
  const qc = useQueryClient();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteName, setDeleteName] = useState("");

  const { data: accounts, isLoading: accountsLoading } = useLiveQuery(accountsCollection);
  const collection = entriesCollection(id);
  const { data: entries } = useLiveQuery(collection);

  const account = (accounts ?? []).find((a) => a.id === id);

  if (accountsLoading || !account) {
    return (
      <AppShell actions={<BackButton />}>
        <p className="text-muted-foreground">
          {accountsLoading ? "Loading…" : "Account not found."}
        </p>
      </AppShell>
    );
  }

  async function archiveAccount() {
    await accountsCollection.update(account!.id, (draft) => {
      draft.isArchived = 1;
    });
    await qc.invalidateQueries({ queryKey: ["networth"] });
  }

  async function restoreAccount() {
    await accountsCollection.update(account!.id, (draft) => {
      draft.isArchived = 0;
    });
    await qc.invalidateQueries({ queryKey: ["networth"] });
  }

  async function deleteAccount() {
    await accountsCollection.delete(account!.id);
    await qc.invalidateQueries({ queryKey: ["networth"] });
    await nav({ to: "/" });
  }

  async function delEntry(entryId: string) {
    await collection.delete(entryId);
    await qc.invalidateQueries({ queryKey: ["networth"] });
  }

  const dangerZone = (
    <section className="mt-12 border-t border-border pt-6">
      <Eyebrow className="mb-3 text-destructive">Danger zone</Eyebrow>
      {account.isArchived === 0 ? (
        <div className="flex items-center justify-between rounded-xl border border-border bg-card px-4 py-3">
          <div>
            <p className="text-sm font-medium">Archive account</p>
            <p className="text-xs text-muted-foreground">
              Hides it from the dashboard. You can restore it later.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={archiveAccount}>
            Archive
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-xl border border-border bg-card px-4 py-3">
            <div>
              <p className="text-sm font-medium">Restore account</p>
              <p className="text-xs text-muted-foreground">
                Makes it visible on the dashboard again.
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={restoreAccount}>
              Restore
            </Button>
          </div>
          <div className="flex items-center justify-between rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3">
            <div>
              <p className="text-sm font-medium text-destructive">Delete permanently</p>
              <p className="text-xs text-muted-foreground">
                Removes all history. Cannot be undone.
              </p>
            </div>
            <Dialog
              open={deleteOpen}
              onOpenChange={(open) => {
                setDeleteOpen(open);
                if (!open) setDeleteName("");
              }}
            >
              <DialogTrigger render={<Button variant="destructive" size="sm" />}>
                Delete permanently
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Delete "{account.name}" permanently?</DialogTitle>
                </DialogHeader>
                <p className="text-sm text-muted-foreground">
                  This deletes the account and all its history. Type the account name to confirm.
                </p>
                <Input
                  value={deleteName}
                  onChange={(e) => setDeleteName(e.target.value)}
                  placeholder={account.name}
                />
                <DialogFooter>
                  <Button
                    variant="destructive"
                    disabled={deleteName !== account.name}
                    onClick={deleteAccount}
                  >
                    Delete permanently
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </div>
      )}
    </section>
  );

  if (account.valuationMode === "holdings") {
    return (
      <AppShell actions={<BackButton />}>
        {account.isArchived === 1 && (
          <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
            This account is archived and hidden from the dashboard.
          </div>
        )}
        <header className="mb-4">
          <Eyebrow>{classLabel(account.class)} · {subtypeLabel(account.subtype)} · {account.currency}</Eyebrow>
          <h1 className="mt-2 font-heading text-3xl tracking-tight">{account.name}</h1>
        </header>
        <section className="mb-4">
          <AccountInfoCard account={account} />
        </section>
        <div className="mb-4 flex flex-wrap gap-2">
          <AccountAssumptionsDialog account={account} />
        </div>
        <HoldingsDetail accountId={id} accountName={account.name} />
        {dangerZone}
      </AppShell>
    );
  }

  const sorted = [...(entries ?? [])].sort((a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : 0,
  );

  return (
    <AppShell actions={<BackButton />}>
      {account.isArchived === 1 && (
        <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
          This account is archived and hidden from the dashboard.
        </div>
      )}

      <header className="mb-5">
        <Eyebrow>
          {classLabel(account.class)} · {subtypeLabel(account.subtype)} · {account.currency}
        </Eyebrow>
        <h1 className="mt-2 font-heading text-3xl tracking-tight">{account.name}</h1>
        <p
          className={cn(
            "mt-1 font-heading text-4xl tabular-nums tracking-tight",
            account.balanceMinor < 0 && "text-destructive",
          )}
        >
          {formatMoney(account.balanceMinor, account.currency)}
        </p>
      </header>

      <AccountInfoCard account={account} />

      <div className="mt-4 flex flex-wrap gap-2">
        <SetBalanceDialog accountId={id} currency={account.currency} mode="set" onDone={() => {}} />
        <SetBalanceDialog accountId={id} currency={account.currency} mode="revalue" onDone={() => {}} />
        <AccountAssumptionsDialog account={account} />
      </div>

      <section className="mt-9">
        <Eyebrow className="mb-3">History</Eyebrow>
        {sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No entries yet. Use "Set balance…" to record where this account stands today.
          </p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            {sorted.map((e, i) => (
              <div
                key={e.id}
                className={cn(
                  "group flex items-center justify-between gap-4 px-4 py-3",
                  i > 0 && "border-t border-border/70",
                )}
              >
                <div className="min-w-0">
                  <p className={cn("tabular-nums", e.amountMinor < 0 && "text-destructive")}>
                    {formatMoney(e.amountMinor, account.currency)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {e.date} · {kindLabel(e.kind)}
                    {e.note ? ` · ${e.note}` : ""}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
                  onClick={() => delEntry(e.id)}
                >
                  Delete
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      {dangerZone}
    </AppShell>
  );
}
