import { useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { formatMoney } from "@/components/money";
import { subtypeLabel, classLabel, kindLabel } from "@/components/labels";
import { SetBalanceDialog } from "@/components/set-balance-dialog";
import { AppShell, Eyebrow } from "@/components/app-layout";
import { Button } from "@/components/ui/button";
import { accountsCollection, entriesCollection } from "@/lib/collections";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { OwnersField } from "@/components/owners-field";
import { OwnersBadge } from "@/components/owners-badge";

const BackButton = () => (
  <Link to="/">
    <Button variant="ghost" size="sm">
      ← Back
    </Button>
  </Link>
);

export function AccountDetailPage() {
  const { id } = useParams({ from: "/accounts/$id" });
  const qc = useQueryClient();
  const [editingOwners, setEditingOwners] = useState(false);
  const [draftOwners, setDraftOwners] = useState<string[]>([]);

  const { data: accounts, isLoading: accountsLoading } =
    useLiveQuery(accountsCollection);
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

  async function delEntry(entryId: string) {
    await collection.delete(entryId);
    await qc.invalidateQueries({ queryKey: ["networth"] });
  }

  async function saveOwners() {
    if (draftOwners.length === 0) return; // at least one owner required
    await api.accounts({ id }).owners.patch({ ownerIds: draftOwners });
    await qc.invalidateQueries({ queryKey: ["accounts"] });
    await qc.invalidateQueries({ queryKey: ["networth"] });
    setEditingOwners(false);
  }

  const sorted = [...(entries ?? [])].sort((a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : 0,
  );

  return (
    <AppShell actions={<BackButton />}>
      <header>
        <Eyebrow>
          {classLabel(account.class)} · {subtypeLabel(account.subtype)} ·{" "}
          {account.currency}
        </Eyebrow>
        <h1 className="mt-2 font-heading text-3xl tracking-tight">
          {account.name}
        </h1>
        <p
          className={cn(
            "mt-1 font-heading text-4xl tabular-nums tracking-tight",
            account.balanceMinor < 0 && "text-destructive",
          )}
        >
          {formatMoney(account.balanceMinor, account.currency)}
        </p>
      </header>

      <section className="mt-4">
        {!editingOwners ? (
          <div className="flex items-center gap-3">
            <OwnersBadge ownerIds={account.ownerIds} />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraftOwners(account!.ownerIds);
                setEditingOwners(true);
              }}
            >
              Edit owners
            </Button>
          </div>
        ) : (
          <div className="max-w-xs space-y-3 rounded-xl border border-border bg-card p-4">
            <Eyebrow>Owners</Eyebrow>
            <OwnersField value={draftOwners} onChange={setDraftOwners} />
            <div className="flex gap-2">
              <Button size="sm" onClick={saveOwners} disabled={draftOwners.length === 0}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditingOwners(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </section>

      <div className="mt-5 flex flex-wrap gap-2">
        <SetBalanceDialog
          accountId={id}
          currency={account.currency}
          mode="set"
          onDone={() => {}}
        />
        <SetBalanceDialog
          accountId={id}
          currency={account.currency}
          mode="revalue"
          onDone={() => {}}
        />
      </div>

      <section className="mt-9">
        <Eyebrow className="mb-3">History</Eyebrow>
        {sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No entries yet. Use “Set balance…” to record where this account
            stands today.
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
                  <p
                    className={cn(
                      "tabular-nums",
                      e.amountMinor < 0 && "text-destructive",
                    )}
                  >
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
    </AppShell>
  );
}
