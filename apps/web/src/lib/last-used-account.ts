// Pure resolver for the default account in the global "Add transaction" flow.
// `txRows` is the all-accounts feed from api.transactions.get(), ordered
// most-recent-first; the first row whose account still exists wins, else the
// first account. JSX-free so it runs under `bun test`.
type TxRow = { account: { id: string } };
type Account = { id: string };

export function resolveDefaultAccountId(
  txRows: TxRow[] | undefined,
  accounts: Account[] | undefined,
): string | undefined {
  const ids = new Set((accounts ?? []).map((a) => a.id));
  const lastUsed = (txRows ?? []).find((r) => ids.has(r.account.id))?.account.id;
  return lastUsed ?? (accounts ?? [])[0]?.id;
}
