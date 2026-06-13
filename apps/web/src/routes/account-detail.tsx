import { useLiveQuery } from "@tanstack/react-db";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { formatMoney } from "@/components/money";
import { SetBalanceDialog } from "@/components/set-balance-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { accountsCollection, entriesCollection } from "@/lib/collections";

export function AccountDetailPage() {
  const { id } = useParams({ from: "/accounts/$id" });
  const qc = useQueryClient();

  const { data: accounts, isLoading: accountsLoading } = useLiveQuery(accountsCollection);

  const collection = entriesCollection(id);
  const { data: entries } = useLiveQuery(collection);

  const account = (accounts ?? []).find((a) => a.id === id);

  if (accountsLoading) {
    return (
      <div className="p-8">
        <Link to="/">
          <Button variant="outline">← Back</Button>
        </Link>
        <p className="mt-4 text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (!account) {
    return (
      <div className="p-8">
        <Link to="/">
          <Button variant="outline">← Back</Button>
        </Link>
        <p className="mt-4">Account not found.</p>
      </div>
    );
  }

  async function delEntry(entryId: string) {
    await collection.delete(entryId);
    await qc.invalidateQueries({ queryKey: ["networth"] });
  }

  return (
    <div className="min-h-screen p-6 md:p-8 max-w-2xl mx-auto space-y-5">
      <Link to="/">
        <Button variant="outline">← Back</Button>
      </Link>
      <div>
        <h1 className="text-2xl font-semibold">{account.name}</h1>
        <p className="text-muted-foreground">
          {account.subtype} · {account.currency}
        </p>
        <p className="text-3xl font-semibold tabular-nums mt-2">
          {formatMoney(account.balanceMinor, account.currency)}
        </p>
      </div>
      <div className="flex gap-2">
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
      <section className="space-y-2">
        <h2 className="text-sm font-medium uppercase text-muted-foreground">
          Entries
        </h2>
        {(entries ?? []).map((e) => (
          <Card key={e.id}>
            <CardContent className="p-3 flex items-center justify-between">
              <div>
                <p className="tabular-nums">
                  {formatMoney(e.amountMinor, account.currency)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {e.date} · {e.kind}
                  {e.note ? ` · ${e.note}` : ""}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => delEntry(e.id)}
              >
                Delete
              </Button>
            </CardContent>
          </Card>
        ))}
        {(entries ?? []).length === 0 && (
          <p className="text-sm text-muted-foreground">No entries yet.</p>
        )}
      </section>
    </div>
  );
}
