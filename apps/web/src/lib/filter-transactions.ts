// Pure, testable filtering for the all-accounts transactions list. Kept free of
// React/api imports so it can be unit-tested in isolation. Ownership (ownerIds /
// ownerNames) is resolved by the caller from the accounts collection + users.

// The sentinel a Select uses for its "no filter" option.
export const ALL = "__all__";

// Structural shape of the fields filtering touches — a subset of the page's
// enriched row, so any richer row type is assignable.
export type FilterableTx = {
  instrument: { symbol: string | null; name: string; kind: string };
  account: { id: string; name: string };
  ownerIds: string[]; // users who own the transaction's account
  ownerNames: string[]; // resolved owner names, for free-text search
  notes: string | null;
};

export type TxFilters = { search: string; kind: string; accountId: string; ownerId: string };

// Free-text search across symbol/name/account/owner/notes, plus exact-match
// instrument-kind and account filters and an owner filter (matches when the
// owner is one of the account's owners). A filter value of ALL means "no
// filter".
export function filterTransactions<T extends FilterableTx>(
  rows: T[],
  { search, kind, accountId, ownerId }: TxFilters,
): T[] {
  const q = search.trim().toLowerCase();
  return rows.filter((t) => {
    if (kind !== ALL && t.instrument.kind !== kind) return false;
    if (accountId !== ALL && t.account.id !== accountId) return false;
    if (ownerId !== ALL && !t.ownerIds.includes(ownerId)) return false;
    if (!q) return true;
    const haystack = [
      t.instrument.symbol ?? "",
      t.instrument.name,
      t.account.name,
      ...t.ownerNames,
      t.notes ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  });
}
