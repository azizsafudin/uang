import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { api } from "@/lib/api";
import { formatMoney } from "@/components/money";
import { SetBalanceDialog } from "@/components/set-balance-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

type Account = {
  id: string;
  name: string;
  class: string;
  subtype: string;
  currency: string;
  balanceMinor: number;
  isArchived: number;
  sortOrder: number;
  valuationMode: string;
  institution: string | null;
  createdAt: number;
  createdBy: string;
};

type Entry = {
  id: string;
  accountId: string;
  date: string;
  amountMinor: number;
  kind: string;
  note: string | null;
  createdAt: number;
  createdBy: string;
};

export function AccountDetailPage() {
  const { id } = useParams({ from: "/accounts/$id" });
  const qc = useQueryClient();

  const accountsQ = useQuery({
    queryKey: ["accounts"],
    queryFn: async (): Promise<Account[]> => {
      const { data, error } = await api.accounts.get();
      if (error) throw new Error(String(error));
      return (data as unknown as Account[]) ?? [];
    },
  });

  const entriesQ = useQuery({
    queryKey: ["entries", id],
    queryFn: async (): Promise<Entry[]> => {
      const { data, error } = await api.accounts({ id }).entries.get();
      if (error) throw new Error(String(error));
      return (data as unknown as Entry[]) ?? [];
    },
  });

  const account = accountsQ.data?.find((a) => a.id === id);

  if (accountsQ.isLoading) {
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
    await api.entries({ id: entryId }).delete();
    await qc.invalidateQueries();
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
        {(entriesQ.data ?? []).map((e) => (
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
        {(entriesQ.data ?? []).length === 0 && (
          <p className="text-sm text-muted-foreground">No entries yet.</p>
        )}
      </section>
    </div>
  );
}
