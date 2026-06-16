# All-transactions page

Date: 2026-06-17

## Goal

A single **Transactions** page that lists every transaction across all accounts,
reusing existing patterns. Read at a glance, click to edit.

## Decisions

- **Show everything**, including auto-generated linked cash legs (same rows the
  per-account history shows today).
- **Clickable to edit** — rows open the existing `EditTransactionDialog`.
- Flat list ordered by date descending; **no filters, no pagination** (YAGNI;
  mirrors the per-account `HistoryPanel`). Volume cap can come later if needed.

## Backend

Add `GET /transactions` to `apps/api/src/routes/transactions.ts` (root path,
auth-guarded). Same join as `GET /accounts/:id/transactions`, plus the account,
across all accounts:

```ts
.get("/transactions", async () => {
  const rows = await db
    .select()
    .from(transactions)
    .innerJoin(instruments, eq(transactions.instrumentId, instruments.id))
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .orderBy(desc(transactions.date), desc(transactions.createdAt));
  return rows.map((r) => ({
    ...r.transactions,
    instrument: { id, symbol, name, kind, currency },   // as today
    account: { id: r.accounts.id, name: r.accounts.name, currency: r.accounts.currency },
  }));
})
```

The row shape is a **superset** of the per-account row (adds `account`), so it
stays compatible with `EditTransactionDialog`'s `tx` prop.

## Frontend

- **New route** `/transactions` → `TransactionsPage` in
  `apps/web/src/routes/transactions.tsx`, registered in `router.tsx` under the
  app layout (like `instrumentsRoute`).
- **Data:** a React Query `["transactions", "all"]` calling `api.transactions.get()`.
- **Layout:** `AppShell` + `PageHeader` (eyebrow "Activity", title "Transactions").
  Reuse the `HistoryPanel` row markup: left column = instrument `symbol · name`
  with a secondary line `date · account name · notes`; right column = signed
  units/amount (red when negative). Empty state mirrors the existing dashed-card
  `EmptyState`.
- **Editing:** clicking a row opens `EditTransactionDialog` with
  `accountId={row.account.id}` and `tx={row}`. On save/delete, invalidate the
  `["transactions"]` query prefix (covers both the all-list and per-account
  collections) plus `["positions"]` / `["networth"]` — the dialog already
  invalidates the latter two; the page additionally refetches the all-list on
  dialog close.
- **Sidebar:** add `{ to: "/transactions", label: "Transactions", icon: <…> }`
  to the nav array in `apps/web/src/components/nav-main.tsx` (e.g. a `Receipt` or
  `ArrowLeftRight` lucide icon), placed after Instruments.

## Testing

- **API route test:** `GET /transactions` returns rows from multiple accounts,
  each with `instrument` + `account` joined, ordered date desc.
- **E2E (affected only):** the Transactions page lists rows spanning more than one
  account; clicking a row opens the edit dialog and an edit persists. Likely
  spec: `transactions.spec.ts`.

## Affected files

- **api:** `routes/transactions.ts` (+ `GET /transactions`).
- **web:** new `routes/transactions.tsx`; `router.tsx` (route);
  `components/nav-main.tsx` (sidebar entry); `lib/api` types.
