# All-transactions Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/transactions` page that lists every transaction across all accounts, with click-to-edit reusing the existing edit dialog.

**Architecture:** A new auth-guarded `GET /transactions` endpoint joins `transactions × instruments × accounts` and returns rows that are a structural superset of the existing per-account row (adds `account`). A new React route renders the rows with the existing `HistoryPanel` layout; clicking a row opens `EditTransactionDialog`, after subscribing to the owning account's collection so the optimistic mutation can find the row.

**Tech Stack:** Elysia + Drizzle (libsql/SQLite) on the API; React + TanStack Router/Query/DB on the web; Eden treaty for end-to-end types; Bun test runner.

---

### Task 1: Backend `GET /transactions`

**Files:**
- Modify: `apps/api/src/routes/transactions.ts` (imports at line 1-9; add route after the existing `GET /accounts/:id/transactions`, i.e. after line 29)
- Test: `apps/api/src/routes/transactions.test.ts`

- [ ] **Step 1: Write the failing test**

Append this test to `apps/api/src/routes/transactions.test.ts` (it already imports `resetDb, makeApp, initAndLogin` and uses `beforeEach(resetDb)`; mirror the existing seeding style — `createId`/`nowEpoch` from `../lib/ids`, raw `db.insert`). Add any missing imports (`accounts`, `instruments`, `transactions` from `../db/schema`; `createId, nowEpoch` from `../lib/ids`) if not already present:

```ts
test("GET /transactions lists transactions across all accounts, newest first", async () => {
  const { cookie } = await initAndLogin({ app });
  const acc1 = createId(), acc2 = createId(), inst = createId();
  await db.insert(accounts).values([
    { id: acc1, name: "Brokerage", class: "asset", subtype: "brokerage", currency: "USD", createdAt: nowEpoch() },
    { id: acc2, name: "Savings", class: "asset", subtype: "cash", currency: "SGD", createdAt: nowEpoch() },
  ]);
  await db.insert(instruments).values({ id: inst, symbol: "AAPL", isin: null, name: "Apple", kind: "stock", currency: "USD", createdAt: nowEpoch() });
  await db.insert(transactions).values([
    { id: createId(), accountId: acc1, instrumentId: inst, date: "2026-01-01", unitsDelta: 100000000, createdAt: nowEpoch(), createdBy: "admin" },
    { id: createId(), accountId: acc2, instrumentId: inst, date: "2026-03-01", unitsDelta: 200000000, createdAt: nowEpoch(), createdBy: "admin" },
  ]);

  const res = await app.handle(new Request("http://localhost/transactions", { headers: { cookie } }));
  expect(res.status).toBe(200);
  const rows = await res.json();
  expect(rows.length).toBe(2);
  // newest date first
  expect(rows[0].date).toBe("2026-03-01");
  expect(rows[0].account.name).toBe("Savings");
  expect(rows[0].instrument.symbol).toBe("AAPL");
  expect(rows[1].account.name).toBe("Brokerage");
});
```

Confirm the test file's top-level `app` is built with `makeApp(transactionsRoutes)` (the file already constructs an app for the existing tests — reuse it). If it is scoped differently, build `const app = makeApp(transactionsRoutes);` near the top.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && bun test src/routes/transactions.test.ts -t "across all accounts"`
Expected: FAIL — `GET /transactions` returns 404 (route not found), so `res.status` is not 200.

- [ ] **Step 3: Add the `accounts` import and the route**

In `apps/api/src/routes/transactions.ts`, line 3, add `accounts` to the schema import:

```ts
import { transactions, instruments, accounts } from "../db/schema";
```

Then insert this route immediately after the existing `.get("/accounts/:id/transactions", …)` block (after its closing `)` on line 29), before `.post(`:

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
      instrument: {
        id: r.instruments.id, symbol: r.instruments.symbol, name: r.instruments.name,
        kind: r.instruments.kind, currency: r.instruments.currency,
      },
      account: { id: r.accounts.id, name: r.accounts.name, currency: r.accounts.currency },
    }));
  })
```

`eq` and `desc` are already imported from `drizzle-orm` at line 4.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && bun test src/routes/transactions.test.ts -t "across all accounts"`
Expected: PASS.

- [ ] **Step 5: Verify the whole file's tests still pass and typecheck**

Run: `cd apps/api && bun test src/routes/transactions.test.ts`
Then: `cd apps/web && bun run build`
Expected: tests PASS; web build (tsgo) succeeds — this regenerates the Eden types so `api.transactions.get()` is available on the client.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/transactions.ts apps/api/src/routes/transactions.test.ts
git commit -m "feat(api): GET /transactions lists all transactions across accounts"
```

---

### Task 2: Frontend `/transactions` route + page

**Files:**
- Create: `apps/web/src/routes/transactions.tsx`
- Modify: `apps/web/src/router.tsx` (import + route def near `instrumentsRoute` at lines 14/112-115, and add to `routeTree` children near line 154)
- Modify: `apps/web/src/components/nav-main.tsx` (NAV array, lines 12-17; icon import line 2)

- [ ] **Step 1: Create the page component**

Create `apps/web/src/routes/transactions.tsx`:

```tsx
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import { AppShell } from "@/components/app-layout";
import { PageHeader } from "@/components/page-header";
import { EditTransactionDialog } from "@/components/edit-transaction-dialog";
import { transactionsCollection, type TransactionRow } from "@/lib/collections";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

const SCALE = 100_000_000;

// The all-accounts row is the per-account TransactionRow plus an `account`.
type AllTxRow = TransactionRow & { account: { id: string; name: string; currency: string } };

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
  const [editing, setEditing] = useState<AllTxRow | null>(null);

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
      ) : (rows ?? []).length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-border bg-card/40 px-4 py-10 text-center text-sm text-muted-foreground">
          No transactions recorded yet.
        </div>
      ) : (
        <div className="mt-6 overflow-hidden rounded-xl border border-border bg-card">
          {(rows ?? []).map((t, i) => {
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
      )}
      {editing && <EditTxPortal row={editing} onClose={closeEditor} />}
    </AppShell>
  );
}
```

Note: clicking a row navigates nowhere (it's a `div`, not a `Link`) — it opens the editor. `Link` is imported for parity with other pages but unused here; drop the import if the linter flags it.

- [ ] **Step 2: Register the route**

In `apps/web/src/router.tsx`, add the import alongside `InstrumentsPage` (line 14):

```ts
import { TransactionsPage } from "./routes/transactions";
```

Add a route definition next to `instrumentsRoute` (after line 116):

```ts
const transactionsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/transactions",
  component: TransactionsPage,
});
```

Add `transactionsRoute` to the `appLayoutRoute.addChildren([...])` array (near line 154, where `instrumentsRoute` is listed).

- [ ] **Step 3: Add the sidebar entry**

In `apps/web/src/components/nav-main.tsx`, add `ArrowLeftRight` to the lucide import (line 2):

```ts
import { LayoutDashboard, Target, TrendingUp, CandlestickChart, ArrowLeftRight } from "lucide-react";
```

Add to the `NAV` array after the Instruments entry (line 14):

```ts
  { to: "/transactions", label: "Transactions", icon: ArrowLeftRight },
```

- [ ] **Step 4: Typecheck the build**

Run: `cd apps/web && bun run build`
Expected: build (tsgo) succeeds with no type errors. In particular, `api.transactions.get()` resolves and `AllTxRow` is assignable to `EditTransactionDialog`'s `tx: TransactionRow` prop.

- [ ] **Step 5: Manual smoke check**

With the local app running, navigate to `/transactions`. Expected: rows from more than one account appear, newest first, each showing instrument · date · account; clicking a row opens the edit dialog; saving an edit updates the row and closes the dialog.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/transactions.tsx apps/web/src/router.tsx apps/web/src/components/nav-main.tsx
git commit -m "feat(web): all-transactions page with click-to-edit"
```

---

### Task 3: E2E coverage (affected spec only)

**Files:**
- Modify or create: `apps/web/e2e/transactions.spec.ts` (follow `e2e/README.md` conventions; reuse its login/seed helpers)

- [ ] **Step 1: Add an e2e test**

Add a spec that: seeds at least two accounts each with a transaction (via the app's existing flows/helpers), visits `/transactions`, asserts `[data-testid="all-tx-row"]` count ≥ 2 and that rows from both accounts are present, clicks the first row, edits the notes in the opened dialog, saves, and asserts the change is reflected. Mirror selectors used in the existing per-account transaction e2e (`edit-tx-notes`, `tx-row` equivalents) and the `all-tx-row` testid added in Task 2.

- [ ] **Step 2: Run the affected spec**

Run: `cd apps/web && bun run e2e -- transactions.spec.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/e2e/transactions.spec.ts
git commit -m "test(e2e): all-transactions page lists and edits across accounts"
```

---

## Self-Review notes

- **Spec coverage:** `GET /transactions` (Task 1) ✓; new route + page + sidebar (Task 2) ✓; show everything incl. cash legs (no filtering in the query) ✓; click-to-edit reuse (Task 2 `EditTxPortal`) ✓; invalidate `["transactions"]` prefix on close ✓; e2e (Task 3) ✓.
- **Types:** `AllTxRow = TransactionRow & { account }` keeps the dialog prop satisfied; `api.transactions.get()` becomes available only after Task 1's web build regenerates Eden types — Task 2 depends on Task 1.
- **No placeholders:** all code is concrete except the e2e body, which intentionally defers to the repo's e2e helpers per `e2e/README.md` (the harness/selectors are repo-specific).
