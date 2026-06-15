import { useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Money } from "@/components/money.tsx";
import { subtypeLabel, classLabel } from "@/components/labels";
import { AppShell, Eyebrow } from "@/components/app-layout";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { accountsCollection } from "@/lib/collections";
import { AccountInfoCard } from "@/components/account-info-card";
import { AddTransactionDialog } from "@/components/add-transaction-dialog";
import { ImportDialog } from "@/components/import-dialog";
import { usePositions, PositionsPanel, HistoryPanel } from "@/components/account-history";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export function AccountDetailPage() {
  const { id } = useParams({ from: "/app/accounts/$id" });
  const nav = useNavigate();
  const qc = useQueryClient();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteName, setDeleteName] = useState("");
  const [tab, setTab] = useState("positions");

  const { data: accounts, isLoading: accountsLoading } = useLiveQuery(accountsCollection);
  const account = (accounts ?? []).find((a) => a.id === id);
  const { data: pos, isLoading: posLoading } = usePositions(id);

  if (accountsLoading || !account) {
    return (
      <AppShell>
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

  const dangerZone = (
    <section className="mt-10">
      <Eyebrow className="mb-3 text-destructive">Danger zone</Eyebrow>
      {account.isArchived === 0 ? (
        <div className="flex items-center justify-between rounded-xl border border-border bg-card px-4 py-3">
          <div>
            <p className="text-sm font-medium">Archive account</p>
            <p className="text-xs text-muted-foreground">
              Hides it from the dashboard. You can restore it later.
            </p>
          </div>
          <Button variant="outline" onClick={archiveAccount}>
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
            <Button variant="outline" onClick={restoreAccount}>
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
              <DialogTrigger render={<Button variant="destructive" />}>
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
                  <Button type="button" variant="ghost" onClick={() => setDeleteOpen(false)}>
                    Cancel
                  </Button>
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

  return (
    <AppShell>
      {account.isArchived === 1 && (
        <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
          This account is archived and hidden from the dashboard.
        </div>
      )}

      <PageHeader
        eyebrow={`${classLabel(account.class)} · ${subtypeLabel(account.subtype)} · ${account.currency}`}
        title={account.name}
      />
      <p
        data-testid="account-total"
        className="-mt-5 font-heading text-4xl tabular-nums tracking-tight"
      >
        {posLoading || !pos ? "—" : <Money minor={pos.totalMinor} currency={account.currency} />}
      </p>
      {pos && pos.missing && (
        <p className="mt-1 text-sm text-destructive">
          Some positions are missing a price or FX rate.
        </p>
      )}

      <div className="mt-5 flex gap-2">
        <AddTransactionDialog accountId={id} accountCurrency={account.currency} />
        <ImportDialog accountId={id} accountCurrency={account.currency} />
      </div>

      <Tabs
        value={tab}
        onValueChange={(v) => typeof v === "string" && setTab(v)}
        className="mt-8"
      >
        <TabsList variant="line" className="w-full justify-start">
          <TabsTrigger value="positions" className="flex-none px-3">
            Positions
          </TabsTrigger>
          <TabsTrigger value="history" className="flex-none px-3">
            History
          </TabsTrigger>
          <TabsTrigger value="details" className="flex-none px-3">
            Details
          </TabsTrigger>
        </TabsList>

        <TabsContent value="positions" className="mt-5">
          <PositionsPanel accountId={id} accountCurrency={account.currency} />
        </TabsContent>
        <TabsContent value="history" className="mt-5">
          <HistoryPanel accountId={id} />
        </TabsContent>
        <TabsContent value="details" className="mt-5">
          <AccountInfoCard account={account} />
          {dangerZone}
        </TabsContent>
      </Tabs>
    </AppShell>
  );
}
