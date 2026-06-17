import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { AppShell } from "@/components/app-layout";
import { PageHeader } from "@/components/page-header";
import { EditTransactionDialog } from "@/components/edit-transaction-dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  accountsCollection,
  transactionsCollection,
  type TransactionRow,
} from "@/lib/collections";
import { filterTransactions, ALL } from "@/lib/filter-transactions";
import { useUsers } from "@/lib/use-users";
import type { TransactionsSearch } from "@/router";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

const SCALE = 100_000_000;
const PAGE_SIZE = 25;

// Group labels for the account dropdown that aren't a member's name.
const SHARED = "Shared"; // account owned by 2+ members
const UNASSIGNED = "Unassigned"; // account with no owner (defensive; shouldn't happen)

// The all-accounts row is the per-account TransactionRow plus an `account`.
type AllTxRow = TransactionRow & { account: { id: string; name: string; currency: string } };
// Same row enriched with the owners of its account (resolved client-side from
// the accounts collection + users), which drives the owner filter and search.
type EnrichedTxRow = AllTxRow & { ownerIds: string[]; ownerNames: string[] };

const KIND_LABELS: Record<string, string> = {
  currency: "Currency",
  stock: "Stock",
  etf: "ETF",
  fund: "Fund",
  crypto: "Crypto",
  other: "Other",
};
const kindLabel = (k: string) => KIND_LABELS[k] ?? k;

function useAllTransactions() {
  return useQuery({
    queryKey: ["transactions", "all"],
    queryFn: async (): Promise<AllTxRow[]> => {
      const { data, error } = await api.transactions.get();
      if (error) throw new Error(String(error));
      return (Array.isArray(data) ? data : []) as AllTxRow[];
    },
  });
}

// Subscribe to the owning account's collection so EditTransactionDialog's
// optimistic update/delete can find the row, then render the dialog.
function EditTxPortal({ row, onClose }: { row: AllTxRow; onClose: () => void }) {
  useLiveQuery(transactionsCollection(row.account.id));
  return (
    <EditTransactionDialog
      accountId={row.account.id}
      tx={row}
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
    />
  );
}

export function TransactionsPage() {
  const qc = useQueryClient();
  const { data: rows, isLoading } = useAllTransactions();
  const { data: accountRows } = useLiveQuery(accountsCollection);
  const { data: users } = useUsers();
  const [editing, setEditing] = useState<AllTxRow | null>(null);

  // URL search params are the source of truth for search/filters/page.
  const sp = useSearch({ from: "/app/transactions" });
  const navigate = useNavigate({ from: "/transactions" });
  const patch = (next: Partial<TransactionsSearch>) =>
    navigate({ search: (prev) => ({ ...prev, ...next }), replace: true });

  const search = sp.q ?? "";
  const kind = sp.kind ?? ALL;
  const accountId = sp.account ?? ALL;
  const ownerId = sp.owner ?? ALL;
  const page = (sp.page ?? 1) - 1; // URL is 1-based; internal slicing is 0-based.

  // Resolve account → owner ids and user id → name once, then enrich each row.
  const ownerIdsByAccount = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const a of accountRows ?? []) m.set(a.id, a.ownerIds);
    return m;
  }, [accountRows]);
  const nameByUser = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of users ?? []) m.set(u.id, u.name);
    return m;
  }, [users]);

  const enriched = useMemo<EnrichedTxRow[]>(() => {
    return (rows ?? []).map((t) => {
      const ownerIds = ownerIdsByAccount.get(t.account.id) ?? [];
      return { ...t, ownerIds, ownerNames: ownerIds.map((id) => nameByUser.get(id) ?? UNASSIGNED) };
    });
  }, [rows, ownerIdsByAccount, nameByUser]);

  // Filter dropdowns only list values that actually appear in the data, and a
  // filter is hidden entirely when there's nothing to choose between (≤1 value).
  const kindOptions = useMemo(
    () => [...new Set(enriched.map((t) => t.instrument.kind))].sort(),
    [enriched],
  );

  // Distinct owners across the accounts that appear in the data.
  const ownerOptions = useMemo(() => {
    const ids = new Set<string>();
    for (const t of enriched) for (const id of t.ownerIds) ids.add(id);
    return [...ids]
      .map((id) => [id, nameByUser.get(id) ?? UNASSIGNED] as const)
      .sort((a, b) => a[1].localeCompare(b[1]));
  }, [enriched, nameByUser]);

  // Accounts that appear, grouped by ownership: a personal account under its
  // owner's name, a 2+-owner account under "Shared". Groups are sorted by name
  // with Shared/Unassigned pinned last.
  const accountGroups = useMemo(() => {
    const accts = new Map<string, { name: string; ownerIds: string[] }>();
    for (const t of enriched) {
      if (!accts.has(t.account.id)) accts.set(t.account.id, { name: t.account.name, ownerIds: t.ownerIds });
    }
    const groups = new Map<string, Array<[string, string]>>();
    for (const [id, a] of accts) {
      const label =
        a.ownerIds.length === 0 ? UNASSIGNED
        : a.ownerIds.length === 1 ? (nameByUser.get(a.ownerIds[0]) ?? UNASSIGNED)
        : SHARED;
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label)!.push([id, a.name]);
    }
    const pinned: Record<string, number> = { [SHARED]: 1, [UNASSIGNED]: 2 };
    return [...groups.entries()]
      .map(([label, list]) => [label, list.sort((a, b) => a[1].localeCompare(b[1]))] as const)
      .sort((a, b) => (pinned[a[0]] ?? 0) - (pinned[b[0]] ?? 0) || a[0].localeCompare(b[0]));
  }, [enriched, nameByUser]);

  const accountCount = useMemo(
    () => accountGroups.reduce((n, [, list]) => n + list.length, 0),
    [accountGroups],
  );
  const accountNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const [, list] of accountGroups) for (const [id, name] of list) m.set(id, name);
    return m;
  }, [accountGroups]);

  const filtered = useMemo(
    () => filterTransactions(enriched, { search, kind, accountId, ownerId }),
    [enriched, search, kind, accountId, ownerId],
  );

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  // Filters/search can shrink the result set; clamp rather than strand the
  // user on a now-empty page.
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  function closeEditor() {
    setEditing(null);
    // Refresh the all-list (and per-account collections) after an edit/delete.
    qc.invalidateQueries({ queryKey: ["transactions"] });
  }

  return (
    <AppShell>
      <PageHeader eyebrow="Activity" title="Transactions" />
      {isLoading ? (
        <p className="mt-6 text-muted-foreground">Loading…</p>
      ) : enriched.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-border bg-card/40 px-4 py-10 text-center text-sm text-muted-foreground">
          No transactions recorded yet.
        </div>
      ) : (
        <>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
            <Input
              type="search"
              placeholder="Search symbol, name, account, owner, notes…"
              value={search}
              // Reset to page 1 (omit page) whenever the query/filters change.
              onChange={(e) => patch({ q: e.target.value || undefined, page: undefined })}
              className="sm:max-w-xs"
              data-testid="tx-search"
            />
            <div className="flex gap-2 sm:ml-auto">
              {kindOptions.length > 1 && (
                <Select
                  value={kind}
                  onValueChange={(v: string | null) => patch({ kind: !v || v === ALL ? undefined : v, page: undefined })}
                >
                  <SelectTrigger className="w-40" data-testid="tx-filter-kind">
                    {/* SelectValue needs a render fn, or it shows the raw value instead of the label. */}
                    <SelectValue>
                      {(v: unknown) => (v === ALL ? "All types" : kindLabel(String(v)))}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>All types</SelectItem>
                    {kindOptions.map((k) => (
                      <SelectItem key={k} value={k}>{kindLabel(k)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {accountCount > 1 && (
                <Select
                  value={accountId}
                  onValueChange={(v: string | null) => patch({ account: !v || v === ALL ? undefined : v, page: undefined })}
                >
                  <SelectTrigger className="w-44" data-testid="tx-filter-account">
                    {/* SelectValue needs a render fn, or it shows the raw value instead of the label. */}
                    <SelectValue>
                      {(v: unknown) =>
                        v === ALL ? "All accounts" : accountNameById.get(String(v)) ?? "All accounts"
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>All accounts</SelectItem>
                    {accountGroups.map(([label, list]) => (
                      <SelectGroup key={label}>
                        <SelectLabel>{label}</SelectLabel>
                        {list.map(([id, name]) => (
                          <SelectItem key={id} value={id}>{name}</SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {ownerOptions.length > 1 && (
                <Select
                  value={ownerId}
                  onValueChange={(v: string | null) => patch({ owner: !v || v === ALL ? undefined : v, page: undefined })}
                >
                  <SelectTrigger className="w-40" data-testid="tx-filter-owner">
                    {/* SelectValue needs a render fn, or it shows the raw value instead of the label. */}
                    <SelectValue>
                      {(v: unknown) =>
                        v === ALL
                          ? "All owners"
                          : ownerOptions.find(([id]) => id === v)?.[1] ?? "All owners"
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>All owners</SelectItem>
                    {ownerOptions.map(([id, name]) => (
                      <SelectItem key={id} value={id}>{name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="mt-4 rounded-xl border border-dashed border-border bg-card/40 px-4 py-10 text-center text-sm text-muted-foreground">
              No transactions match your filters.
            </div>
          ) : (
            <>
              <div className="mt-4 overflow-hidden rounded-xl border border-border bg-card">
                {pageRows.map((t, i) => {
                  const isCash = t.instrument.kind === "currency";
                  const amountMajor = t.unitsDelta / SCALE;
                  return (
                    <div
                      key={t.id}
                      data-testid="all-tx-row"
                      role="button"
                      tabIndex={0}
                      onClick={() => setEditing(t)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setEditing(t); }
                      }}
                      className={cn(
                        "flex cursor-pointer items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-muted/50",
                        i > 0 && "border-t border-border/70",
                      )}
                    >
                      <div className="min-w-0">
                        <p className="truncate font-medium">
                          {t.instrument.symbol ? `${t.instrument.symbol} · ` : ""}
                          {t.instrument.name}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {t.date} · {t.account.name}
                          {t.notes ? ` · ${t.notes}` : ""}
                        </p>
                      </div>
                      <p className={cn("shrink-0 tabular-nums", t.unitsDelta < 0 && "text-destructive")}>
                        {t.unitsDelta >= 0 ? "+" : ""}
                        {amountMajor} {isCash ? t.instrument.currency : "units"}
                      </p>
                    </div>
                  );
                })}
              </div>

              <div className="mt-3 flex items-center justify-end gap-3 text-sm text-muted-foreground">
                <span data-testid="tx-page-label">
                  Page {safePage + 1} of {pageCount}
                </span>
                <div className="flex gap-1">
                  <Button
                    variant="outline"
                    size="icon"
                    disabled={safePage === 0}
                    // page 1 omits the param entirely to keep the URL clean.
                    onClick={() => patch({ page: safePage <= 1 ? undefined : safePage })}
                    aria-label="Previous page"
                    data-testid="tx-prev-page"
                  >
                    <ChevronLeftIcon />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    disabled={safePage >= pageCount - 1}
                    onClick={() => patch({ page: safePage + 2 })}
                    aria-label="Next page"
                    data-testid="tx-next-page"
                  >
                    <ChevronRightIcon />
                  </Button>
                </div>
              </div>
            </>
          )}
        </>
      )}
      {editing && <EditTxPortal row={editing} onClose={closeEditor} />}
    </AppShell>
  );
}
