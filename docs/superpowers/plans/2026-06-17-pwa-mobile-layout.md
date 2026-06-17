# PWA Mobile Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give installed-PWA users on a phone an app-shell layout — a bottom tab bar (Home / Transactions / + / Assets / More) replacing the top breadcrumb header, with theme + privacy toggles relocated into the sidebar.

**Architecture:** A mode gate `useIsPWA() && useIsMobile()` (computed inline, no new hook) drives a branch in the authenticated layout route (`router.tsx`). When true: hide the top bar, render a fixed `PwaTabBar`, pad content for it, and show the toggles in the sidebar footer. Browser and desktop-installed-PWA layouts are unchanged. The global "+" reuses a refactored `AddTransactionDialog` that accepts an optional account (defaulting to the last-used one) and controlled open state.

**Tech Stack:** React, TanStack Router, TanStack Query/DB, shadcn/ui (base-ui), Tailwind, Bun, Vite (tsgo typecheck via `bun run build`).

**Design:** `docs/superpowers/specs/2026-06-17-pwa-mobile-layout-design.md`

---

## File Structure

- Create: `apps/web/src/lib/last-used-account.ts` — pure resolver for the global add-transaction default account.
- Create: `apps/web/src/lib/last-used-account.test.ts` — unit tests (bun:test).
- Create: `apps/web/src/components/value-privacy-toggle.tsx` — extracted privacy eye toggle (was inline in `router.tsx`).
- Create: `apps/web/src/components/app-top-bar.tsx` — extracted sticky top header (browser/desktop layout).
- Create: `apps/web/src/components/pwa-tab-bar.tsx` — the bottom tab bar + global add-transaction mount.
- Create: `apps/web/src/routes/assets.tsx` — `AssetsPage` stub.
- Modify: `apps/web/src/hooks/use-pwa.ts` — synchronous initial state (kill first-paint flash).
- Modify: `apps/web/src/components/add-transaction-dialog.tsx` — optional account + controlled open + global account select.
- Modify: `apps/web/src/components/app-sidebar.tsx` — toggles in footer when PWA-mobile.
- Modify: `apps/web/src/components/nav-main.tsx` — add Assets nav entry.
- Modify: `apps/web/src/router.tsx` — `AppLayout` branch, `/assets` route, import the extracted pieces.

> **Note on TDD scope:** Only `last-used-account.ts` is purely unit-testable (no DOM harness exists in `apps/web` — existing `*.test.ts` are all pure). PWA display-mode cannot be emulated in Playwright, so PWA-specific UI is verified by `bun run build` (typecheck) + manual check in an installed PWA. Browser-mode layout is unchanged and covered by existing E2E specs (Task 9).

---

### Task 1: Last-used-account resolver (TDD)

**Files:**
- Create: `apps/web/src/lib/last-used-account.ts`
- Test: `apps/web/src/lib/last-used-account.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/last-used-account.test.ts`:

```ts
import { expect, test } from "bun:test";
import { resolveDefaultAccountId } from "./last-used-account";

test("returns the most-recent transaction's account", () => {
  // api.transactions.get() is ordered most-recent-first.
  const tx = [{ account: { id: "b" } }, { account: { id: "a" } }];
  const accounts = [{ id: "a" }, { id: "b" }];
  expect(resolveDefaultAccountId(tx, accounts)).toBe("b");
});

test("skips a most-recent account that no longer exists", () => {
  const tx = [{ account: { id: "gone" } }, { account: { id: "a" } }];
  const accounts = [{ id: "a" }, { id: "b" }];
  expect(resolveDefaultAccountId(tx, accounts)).toBe("a");
});

test("falls back to the first account when there are no transactions", () => {
  expect(resolveDefaultAccountId([], [{ id: "a" }, { id: "b" }])).toBe("a");
  expect(resolveDefaultAccountId(undefined, [{ id: "x" }])).toBe("x");
});

test("returns undefined when there are no accounts", () => {
  expect(resolveDefaultAccountId([{ account: { id: "a" } }], [])).toBeUndefined();
  expect(resolveDefaultAccountId(undefined, undefined)).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bun test src/lib/last-used-account.test.ts`
Expected: FAIL — `Cannot find module './last-used-account'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/web/src/lib/last-used-account.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && bun test src/lib/last-used-account.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/last-used-account.ts apps/web/src/lib/last-used-account.test.ts
git commit -m "feat: resolveDefaultAccountId for global add-transaction"
```

---

### Task 2: Synchronous `useIsPWA` init

**Files:**
- Modify: `apps/web/src/hooks/use-pwa.ts`

- [ ] **Step 1: Initialize state synchronously**

In `apps/web/src/hooks/use-pwa.ts`, change the state init so the first render already reflects standalone mode (matchMedia is synchronous), removing the `undefined` flash.

Replace:

```ts
  const [isPWA, setIsPWA] = React.useState<boolean | undefined>(undefined)
```

with:

```ts
  // Initialize synchronously (matchMedia is sync) so the very first render
  // already knows whether we're standalone — avoids a layout flash.
  const [isPWA, setIsPWA] = React.useState<boolean>(detectPWA)
```

And change the return from `return !!isPWA` to:

```ts
  return isPWA
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && bun run build`
Expected: builds clean (no type errors).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/hooks/use-pwa.ts
git commit -m "feat: useIsPWA initializes synchronously to avoid layout flash"
```

---

### Task 3: Extract `ValuePrivacyToggle`

**Files:**
- Create: `apps/web/src/components/value-privacy-toggle.tsx`
- Modify: `apps/web/src/router.tsx`

- [ ] **Step 1: Create the component**

Create `apps/web/src/components/value-privacy-toggle.tsx`:

```tsx
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useValuesHidden } from "@/lib/values-hidden";

// The eye toggle that masks money values. Extracted from router.tsx so both the
// top bar and the PWA sidebar footer can render it.
export function ValuePrivacyToggle() {
  const { hidden, toggle } = useValuesHidden();
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      onClick={toggle}
      aria-pressed={hidden}
      aria-label={hidden ? "Show values" : "Hide values"}
      title={hidden ? "Show values" : "Hide values"}
    >
      {hidden ? <EyeOff /> : <Eye />}
    </Button>
  );
}
```

- [ ] **Step 2: Remove the inline copy from `router.tsx`**

In `apps/web/src/router.tsx`, delete the inline `ValuePrivacyToggle` function (the `function ValuePrivacyToggle() { ... }` block). It will be re-imported by `AppTopBar` in Task 4 — at this intermediate step `router.tsx` still references it in the header, so add the import now:

Add to the imports near the other component imports:

```tsx
import { ValuePrivacyToggle } from "@/components/value-privacy-toggle";
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/web && bun run build`
Expected: builds clean. (`useValuesHidden`, `Eye`, `EyeOff` may now be unused imports in `router.tsx` — they are fully removed in Task 5; tsgo does not fail the build on unused imports, but if it does, remove them now.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/value-privacy-toggle.tsx apps/web/src/router.tsx
git commit -m "refactor: extract ValuePrivacyToggle into its own component"
```

---

### Task 4: Extract `AppTopBar`

**Files:**
- Create: `apps/web/src/components/app-top-bar.tsx`
- Modify: `apps/web/src/router.tsx` (wiring happens in Task 5)

- [ ] **Step 1: Create the component**

Create `apps/web/src/components/app-top-bar.tsx` (verbatim copy of today's header markup):

```tsx
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { AppBreadcrumb } from "@/components/app-breadcrumb";
import { ThemeToggle } from "@/components/theme-toggle";
import { ValuePrivacyToggle } from "@/components/value-privacy-toggle";

// The sticky top header for browser / desktop-PWA layout: sidebar trigger,
// breadcrumb, and the value-privacy + theme toggles. Hidden in PWA-mobile mode,
// where the toggles move to the sidebar footer.
export function AppTopBar() {
  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b border-border/70 bg-background/95 px-4 backdrop-blur">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 h-4" />
      <AppBreadcrumb />
      <div className="ml-auto flex items-center gap-1">
        <ValuePrivacyToggle />
        <ThemeToggle />
      </div>
    </header>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && bun run build`
Expected: builds clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/app-top-bar.tsx
git commit -m "refactor: extract AppTopBar header into its own component"
```

---

### Task 5: Refactor `AddTransactionDialog` for optional account + controlled open

**Files:**
- Modify: `apps/web/src/components/add-transaction-dialog.tsx` (full rewrite below)

The account-detail usage (`<AddTransactionDialog accountId={id} accountCurrency={account.currency} />`) keeps working unchanged: when `accountId` is passed, no account picker shows and open state is internal with a trigger button. When `accountId` is omitted (global "+"), an account `<Select>` appears at the top pre-filled to the last-used account, and open is controlled by the parent.

- [ ] **Step 1: Replace the file contents**

Overwrite `apps/web/src/components/add-transaction-dialog.tsx` with:

```tsx
import { useEffect, useMemo, useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { useLiveQuery } from "@tanstack/react-db";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SCALE, currencyDecimals } from "@uang/shared";
import { accountsCollection, instrumentsCollection, transactionsCollection, newId } from "@/lib/collections";
import { api } from "@/lib/api";
import { resolveDefaultAccountId } from "@/lib/last-used-account";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import { Field } from "@/components/ui/field";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger,
} from "@/components/ui/responsive-dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { NewInstrumentForm, type NewInstrumentSpec } from "@/components/new-instrument-form";

const S = Number(SCALE);
const NEW_CURRENCY = "__new_currency__";
const NEW_INSTRUMENT = "__new_instrument__";
const today = () => new Date().toISOString().slice(0, 10);

type FormValues = {
  instrumentId: string;
  newCurrency: string;
  amount: string;
  side: "buy" | "sell";
  units: string;
  price: string;
  fees: string;
  recordCash: boolean;
  cashCurrencyId: string;
  date: string;
  notes: string;
};

type AddTransactionDialogProps = {
  // When omitted, the dialog runs in "global" mode: it shows an account picker
  // (pre-filled to the last-used account) and expects controlled open state.
  accountId?: string;
  accountCurrency?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  showTrigger?: boolean;
};

export function AddTransactionDialog({
  accountId,
  accountCurrency,
  open,
  onOpenChange,
  showTrigger = true,
}: AddTransactionDialogProps) {
  const qc = useQueryClient();
  const globalMode = accountId === undefined;

  // Open state: controlled by the parent when `open` is provided, else internal.
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = open !== undefined;
  const dialogOpen = isControlled ? open : internalOpen;

  const [splitApplied, setSplitApplied] = useState(false);
  const [newSpec, setNewSpec] = useState<NewInstrumentSpec | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const { data: instruments } = useLiveQuery(instrumentsCollection);
  const { data: accounts } = useLiveQuery(accountsCollection);

  // Global mode needs the all-accounts feed to pick the last-used account.
  const { data: allTx } = useQuery({
    queryKey: ["transactions", "all"],
    queryFn: async () => {
      const { data, error } = await api.transactions.get();
      if (error) throw new Error(String(error));
      return Array.isArray(data) ? data : [];
    },
    enabled: globalMode,
  });

  const effectiveAccountId = accountId ?? selectedAccountId;
  const effectiveAccountCurrency =
    accountCurrency ?? (accounts ?? []).find((a) => a.id === effectiveAccountId)?.currency ?? "";

  // Pre-select the last-used account the first time global mode has data.
  useEffect(() => {
    if (!globalMode || selectedAccountId) return;
    const def = resolveDefaultAccountId(allTx, accounts);
    if (def) setSelectedAccountId(def);
  }, [globalMode, selectedAccountId, allTx, accounts]);

  const currencies = useMemo(() => (instruments ?? []).filter((i) => i.kind === "currency"), [instruments]);
  const securities = useMemo(() => (instruments ?? []).filter((i) => i.kind !== "currency"), [instruments]);

  const defaults = (): FormValues => ({
    instrumentId: "",
    newCurrency: effectiveAccountCurrency,
    amount: "",
    side: "buy",
    units: "",
    price: "",
    fees: "",
    recordCash: true,
    cashCurrencyId: "",
    date: today(),
    notes: "",
  });

  const { register, handleSubmit, control, watch, setValue, reset } = useForm<FormValues>({
    defaultValues: defaults(),
  });

  function resetForm() {
    reset(defaults());
    setSplitApplied(false);
    setNewSpec(null);
  }

  function setDialogOpen(v: boolean) {
    if (isControlled) onOpenChange?.(v);
    else setInternalOpen(v);
  }

  // Reactive reads driving conditional fields and derived hints.
  const instrumentId = watch("instrumentId");
  const amount = watch("amount");
  const units = watch("units");
  const price = watch("price");
  const fees = watch("fees");
  const side = watch("side");
  const recordCash = watch("recordCash");

  const selected = (instruments ?? []).find((i) => i.id === instrumentId);
  const isCurrencyMode = instrumentId === NEW_CURRENCY || selected?.kind === "currency";
  const currencyModeCurrency =
    instrumentId === NEW_CURRENCY ? watch("newCurrency").toUpperCase() : selected?.currency ?? effectiveAccountCurrency;

  const amountNum = parseFloat(amount);

  // Loan-payment helper: on a liability with an interest rate, a positive cash
  // payment is part interest, part principal. Only the principal pays down the
  // balance, so we suggest the principal amount and prefill the interest in the
  // note. One month of interest on the outstanding balance (matches projections).
  const acctRow = (accounts ?? []).find((a) => a.id === effectiveAccountId);
  const dec = currencyDecimals(effectiveAccountCurrency || "USD");
  const loanRateBps = acctRow?.class === "liability" ? acctRow.growthRateBps : 0;
  const outstandingMajor = acctRow ? Math.abs(acctRow.balanceMinor) / 10 ** dec : 0;
  const monthlyInterestMajor = (outstandingMajor * (loanRateBps / 10000)) / 12;
  const principalMajor = amountNum - monthlyInterestMajor;
  const showLoanSplit =
    isCurrencyMode &&
    loanRateBps > 0 &&
    (acctRow?.balanceMinor ?? 0) < 0 &&
    !Number.isNaN(amountNum) &&
    principalMajor > 0 &&
    !splitApplied;

  function applyLoanSplit() {
    setValue("amount", principalMajor.toFixed(dec));
    setValue("notes", `Interest: ${monthlyInterestMajor.toFixed(dec)} ${effectiveAccountCurrency} (${loanRateBps / 100}%/yr)`);
    setSplitApplied(true);
  }

  const securityCurrency =
    instrumentId === NEW_INSTRUMENT ? (newSpec?.currency ?? effectiveAccountCurrency) : selected?.currency ?? effectiveAccountCurrency;
  const cashAmount = (parseFloat(units) || 0) * (parseFloat(price) || 0) + (parseFloat(fees) || 0);

  async function ensureCurrencyId(symbol: string): Promise<string> {
    const { data, error } = await api.instruments.currency.post({ symbol: symbol.toUpperCase() });
    if (error || !data || !("id" in data)) throw new Error(String(error ?? "currency create failed"));
    await instrumentsCollection.utils.refetch();
    return data.id;
  }

  async function onSubmit(values: FormValues) {
    if (!effectiveAccountId) return;
    const sel = (instruments ?? []).find((i) => i.id === values.instrumentId);
    const isCash = values.instrumentId === NEW_CURRENCY || sel?.kind === "currency";

    if (isCash) {
      // Resolve the currency instrument id.
      let id = values.instrumentId;
      if (values.instrumentId === NEW_CURRENCY) id = await ensureCurrencyId(values.newCurrency);
      const amt = parseFloat(values.amount);
      if (Number.isNaN(amt) || amt === 0) return;
      const { error } = await api.accounts({ id: effectiveAccountId }).transactions.post({
        id: newId(),
        instrumentId: id,
        date: values.date,
        unitsDelta: Math.round(amt * S),
        unitPriceScaled: S,
        notes: values.notes || undefined,
      });
      if (error) throw new Error(String(error));
    } else {
      // Resolve the security instrument id.
      let id = values.instrumentId;
      if (values.instrumentId === NEW_INSTRUMENT) {
        if (!newSpec) return;
        const { data, error } = await api.instruments.post({
          name: newSpec.name,
          kind: newSpec.kind,
          currency: newSpec.currency,
          symbol: newSpec.symbol ?? undefined,
          isin: newSpec.isin ?? undefined,
        });
        if (error || !data || !("id" in data) || !data.id) throw new Error(String(error ?? "instrument create failed"));
        id = data.id;
        await instrumentsCollection.utils.refetch();
        if (newSpec.symbol || newSpec.isin) {
          await api["market-data"].instrument({ id: data.id }).refresh.post({ backfill: true });
        }
      }
      const u = parseFloat(values.units);
      const p = parseFloat(values.price);
      const fee = parseFloat(values.fees);
      if (Number.isNaN(u) || Number.isNaN(p)) return;
      const secCurrency =
        values.instrumentId === NEW_INSTRUMENT ? newSpec!.currency : sel?.currency ?? effectiveAccountCurrency;
      const secDec = currencyDecimals(secCurrency);
      const signedUnits = values.side === "buy" ? u : -u;
      const cash = u * p + (Number.isNaN(fee) ? 0 : fee);

      // Optional cash leg: a buy spends cash (negative), a sell receives cash (positive).
      let cashLeg: { instrumentId: string; unitsDelta: number } | undefined;
      if (values.recordCash) {
        const cashId = values.cashCurrencyId || (await ensureCurrencyId(secCurrency));
        const cashUnits = values.side === "buy" ? -cash : cash;
        cashLeg = { instrumentId: cashId, unitsDelta: Math.round(cashUnits * S) };
      }

      const { error } = await api.accounts({ id: effectiveAccountId }).transactions.post({
        id: newId(),
        instrumentId: id,
        date: values.date,
        unitsDelta: Math.round(signedUnits * S),
        unitPriceScaled: Math.round(p * S),
        feesMinor: Number.isNaN(fee) ? 0 : Math.round(fee * 10 ** secDec),
        notes: values.notes || undefined,
        cashLeg,
      });
      if (error) throw new Error(String(error));
    }

    await transactionsCollection(effectiveAccountId).utils.refetch();
    await qc.invalidateQueries({ queryKey: ["positions", effectiveAccountId] });
    await qc.invalidateQueries({ queryKey: ["networth"] });
    await qc.invalidateQueries({ queryKey: ["transactions", "all"] });
    setDialogOpen(false);
    resetForm();
  }

  return (
    <ResponsiveDialog open={dialogOpen} onOpenChange={(v) => { setDialogOpen(v); if (!v) resetForm(); }}>
      {showTrigger ? (
        <ResponsiveDialogTrigger render={<Button />}>Add transaction</ResponsiveDialogTrigger>
      ) : null}
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Add transaction</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="flex min-h-0 flex-1 flex-col">
          <ResponsiveDialogBody className="space-y-4">
            {globalMode ? (
              <Field label="Account">
                <Select value={selectedAccountId} onValueChange={(v: string | null) => v && setSelectedAccountId(v)}>
                  <SelectTrigger className="w-full" data-testid="tx-account">
                    <SelectValue>
                      {(v: unknown) => {
                        const a = (accounts ?? []).find((x) => x.id === String(v));
                        return a ? a.name : "Select account";
                      }}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {(accounts ?? []).map((a) => (
                      <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : null}

            <Field label="Instrument">
              <Controller
                control={control}
                name="instrumentId"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={(v: string | null) => v && field.onChange(v)}>
                    <SelectTrigger className="w-full" data-testid="tx-instrument">
                      <SelectValue>
                        {(v: unknown) => {
                          const val = String(v);
                          if (val === NEW_CURRENCY) return "New currency…";
                          if (val === NEW_INSTRUMENT) return "New instrument…";
                          if (!val) return "Select instrument";
                          const i = (instruments ?? []).find((x) => x.id === val);
                          return i ? (i.symbol ? `${i.symbol} — ${i.name}` : i.name) : "Select";
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {/* Cash / currencies first */}
                      {currencies.map((i) => (
                        <SelectItem key={i.id} value={i.id}>{i.symbol} — {i.name} (cash)</SelectItem>
                      ))}
                      <SelectItem value={NEW_CURRENCY}>New currency…</SelectItem>
                      {securities.map((i) => (
                        <SelectItem key={i.id} value={i.id}>{i.symbol ? `${i.symbol} — ${i.name}` : i.name}</SelectItem>
                      ))}
                      <SelectItem value={NEW_INSTRUMENT}>New instrument…</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>

            {instrumentId === NEW_CURRENCY && (
              <Field label="Currency code">
                <Input data-testid="tx-new-currency" maxLength={3} required {...register("newCurrency", { required: true })} />
              </Field>
            )}

            {instrumentId === NEW_INSTRUMENT && (
              <NewInstrumentForm defaultCurrency={effectiveAccountCurrency} onResolved={setNewSpec} />
            )}

            {instrumentId === "" ? (
              <p className="text-sm text-muted-foreground">
                Pick an instrument above — cash to record a deposit or withdrawal, or a security to buy or sell.
              </p>
            ) : isCurrencyMode ? (
              <>
                <Field label="Amount (+ add, − subtract)">
                  <Controller
                    control={control}
                    name="amount"
                    rules={{ required: true }}
                    render={({ field }) => (
                      <MoneyInput
                        data-testid="tx-amount"
                        currency={currencyModeCurrency}
                        value={field.value}
                        onChange={(v) => { field.onChange(v); setSplitApplied(false); }}
                        className={cn(
                          !Number.isNaN(amountNum) && (amountNum < 0 ? "text-destructive" : "text-emerald-600")
                        )}
                        required
                      />
                    )}
                  />
                </Field>
                {showLoanSplit && (
                  <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
                    <p className="text-muted-foreground">
                      Loan payment: ~{monthlyInterestMajor.toFixed(dec)} {effectiveAccountCurrency} interest this month ·{" "}
                      {principalMajor.toFixed(dec)} principal.
                    </p>
                    <Button type="button" variant="outline" size="sm" className="mt-2"
                            data-testid="tx-loan-split"
                            onClick={applyLoanSplit}>
                      Use principal {principalMajor.toFixed(dec)} + note interest
                    </Button>
                  </div>
                )}
              </>
            ) : instrumentId === NEW_INSTRUMENT && !newSpec ? (
              <p className="text-sm text-muted-foreground">
                Look up a symbol or ISIN above (or add one manually) to continue.
              </p>
            ) : (
              <>
                <Field label="Side">
                  <Controller
                    control={control}
                    name="side"
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={(v: string | null) => v && field.onChange(v as "buy" | "sell")}>
                        <SelectTrigger className="w-full" data-testid="tx-side"><SelectValue>{(v: unknown) => String(v) === "sell" ? "Sell" : "Buy"}</SelectValue></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="buy">Buy</SelectItem>
                          <SelectItem value="sell">Sell</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  />
                </Field>
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Units">
                    <Input data-testid="tx-units" type="number" step="any" required {...register("units", { required: true })} />
                  </Field>
                  <Field label={`Price (${securityCurrency})`}>
                    <Input data-testid="tx-price" type="number" step="any" required {...register("price", { required: true })} />
                  </Field>
                  <Field label="Fees">
                    <Input data-testid="tx-fees" type="number" step="any" placeholder="optional" {...register("fees")} />
                  </Field>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" data-testid="tx-record-cash" {...register("recordCash")} />
                  Also record cash {side === "buy" ? "outflow" : "inflow"} ({side === "buy" ? "−" : "+"}{cashAmount.toFixed(2)} {securityCurrency})
                </label>
                {recordCash && currencies.length > 0 && (
                  <Field label="Cash from">
                    <Controller
                      control={control}
                      name="cashCurrencyId"
                      render={({ field }) => (
                        <Select value={field.value} onValueChange={(v: string | null) => v && field.onChange(v)}>
                          <SelectTrigger className="w-full"><SelectValue>{(v: unknown) => {
                            const i = currencies.find((c) => c.id === String(v));
                            return i ? `${i.symbol} — ${i.name}` : `${securityCurrency} (auto)`;
                          }}</SelectValue></SelectTrigger>
                          <SelectContent>
                            {currencies.map((i) => (<SelectItem key={i.id} value={i.id}>{i.symbol} — {i.name}</SelectItem>))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </Field>
                )}
              </>
            )}

            <div className="grid grid-cols-2 gap-4">
              <Field label="Date">
                <Input data-testid="tx-date" type="date" required {...register("date", { required: true })} />
              </Field>
              <Field label="Notes">
                <Input data-testid="tx-notes" placeholder="optional" {...register("notes")} />
              </Field>
            </div>
          </ResponsiveDialogBody>

          <ResponsiveDialogFooter>
            <Button type="button" variant="ghost" onClick={() => { setDialogOpen(false); resetForm(); }}>
              Cancel
            </Button>
            <Button type="submit" disabled={!instrumentId || (globalMode && !selectedAccountId) || (instrumentId === NEW_INSTRUMENT && !newSpec)}>Add</Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && bun run build`
Expected: builds clean. (Account-detail still passes `accountId`/`accountCurrency`; props are now optional so it remains valid.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/add-transaction-dialog.tsx
git commit -m "feat: AddTransactionDialog supports global mode (optional account, controlled open)"
```

---

### Task 6: Assets stub page + route + sidebar nav

**Files:**
- Create: `apps/web/src/routes/assets.tsx`
- Modify: `apps/web/src/router.tsx`
- Modify: `apps/web/src/components/nav-main.tsx`

- [ ] **Step 1: Create the stub page**

Create `apps/web/src/routes/assets.tsx`:

```tsx
import { AppShell } from "@/components/app-layout";
import { PageHeader } from "@/components/page-header";

// Stub — destined to become the accounts/holdings (asset) breakdown.
export function AssetsPage() {
  return (
    <AppShell>
      <PageHeader eyebrow="Holdings" title="Assets" />
      <p className="mt-6 text-sm text-muted-foreground">Coming soon.</p>
    </AppShell>
  );
}
```

- [ ] **Step 2: Register the route in `router.tsx`**

Add the import near the other route imports:

```tsx
import { AssetsPage } from "./routes/assets";
```

Add the route definition (after `dashboardRoute`, before `accountDetailRoute`):

```tsx
const assetsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/assets",
  component: AssetsPage,
});
```

Add `assetsRoute` to the `appLayoutRoute.addChildren([...])` array (alongside `dashboardRoute`):

```tsx
  appLayoutRoute.addChildren([
    dashboardRoute,
    assetsRoute,
    accountDetailRoute,
    instrumentsRoute,
    transactionsRoute,
    instrumentDetailRoute,
    settingsRoute,
    projectionsRoute,
    goalsRoute,
    goalDetailRoute,
  ]),
```

- [ ] **Step 3: Add Assets to the sidebar nav**

In `apps/web/src/components/nav-main.tsx`, add `Wallet` to the lucide import and an Assets entry to `NAV`:

Change the import line:

```tsx
import { LayoutDashboard, Target, TrendingUp, CandlestickChart, ArrowLeftRight, Wallet } from "lucide-react";
```

Change the `NAV` array to include Assets (second position):

```tsx
const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/assets", label: "Assets", icon: Wallet },
  { to: "/instruments", label: "Instruments", icon: CandlestickChart },
  { to: "/transactions", label: "Transactions", icon: ArrowLeftRight },
  { to: "/goals", label: "Goals", icon: Target },
  { to: "/projections", label: "Projections", icon: TrendingUp },
] as const;
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/web && bun run build`
Expected: builds clean. The TanStack Router type registry now knows `/assets` (so the breadcrumb/Link types resolve).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/assets.tsx apps/web/src/router.tsx apps/web/src/components/nav-main.tsx
git commit -m "feat: Assets stub page + route + sidebar nav entry"
```

---

### Task 7: `PwaTabBar` component

**Files:**
- Create: `apps/web/src/components/pwa-tab-bar.tsx`

- [ ] **Step 1: Create the component**

Create `apps/web/src/components/pwa-tab-bar.tsx`:

```tsx
import { useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { Home, ArrowLeftRight, Plus, Wallet, Menu, type LucideIcon } from "lucide-react";
import { useSidebar } from "@/components/ui/sidebar";
import { AddTransactionDialog } from "@/components/add-transaction-dialog";
import { cn } from "@/lib/utils";

type TabTo = "/" | "/transactions" | "/assets";

function TabLink({ to, icon: Icon, label, active }: { to: TabTo; icon: LucideIcon; label: string; active: boolean }) {
  return (
    <Link
      to={to}
      aria-label={label}
      className={cn(
        "flex flex-1 flex-col items-center justify-center gap-0.5 text-[0.65rem] font-medium",
        active ? "text-primary" : "text-muted-foreground",
      )}
    >
      <Icon className="size-5" />
      <span>{label}</span>
    </Link>
  );
}

function TabButton({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex flex-1 flex-col items-center justify-center gap-0.5 text-[0.65rem] font-medium text-muted-foreground"
    >
      <Icon className="size-5" />
      <span>{label}</span>
    </button>
  );
}

// Bottom tab bar shown only in PWA-mobile mode (gated by the layout route).
export function PwaTabBar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { setOpenMobile } = useSidebar();
  const [addOpen, setAddOpen] = useState(false);

  return (
    <>
      <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-background/95 backdrop-blur pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto flex h-16 max-w-5xl items-stretch justify-around">
          <TabLink to="/" icon={Home} label="Home" active={pathname === "/"} />
          <TabLink to="/transactions" icon={ArrowLeftRight} label="Transactions" active={pathname.startsWith("/transactions")} />
          {/* Center "+" — raised accent button that opens the global add-transaction flow. */}
          <div className="flex flex-1 items-center justify-center">
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              aria-label="Add transaction"
              className="-mt-6 flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg ring-4 ring-background"
            >
              <Plus className="size-6" />
            </button>
          </div>
          <TabLink to="/assets" icon={Wallet} label="Assets" active={pathname.startsWith("/assets")} />
          <TabButton icon={Menu} label="More" onClick={() => setOpenMobile(true)} />
        </div>
      </nav>
      <AddTransactionDialog open={addOpen} onOpenChange={setAddOpen} showTrigger={false} />
    </>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && bun run build`
Expected: builds clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/pwa-tab-bar.tsx
git commit -m "feat: PwaTabBar bottom navigation with global add-transaction"
```

---

### Task 8: Wire the layout route + sidebar toggles

**Files:**
- Modify: `apps/web/src/router.tsx`
- Modify: `apps/web/src/components/app-sidebar.tsx`

- [ ] **Step 1: Rework the layout component in `router.tsx`**

Ensure these imports are present (add the missing ones, remove the ones now only used by `AppTopBar`):

```tsx
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppSidebar } from "@/components/app-sidebar";
import { AppTopBar } from "@/components/app-top-bar";
import { PwaTabBar } from "@/components/pwa-tab-bar";
import { ValuesHiddenProvider } from "@/lib/values-hidden";
import { useIsPWA } from "@/hooks/use-pwa";
import { useIsMobile } from "@/hooks/use-mobile";
```

Remove now-unused imports from `router.tsx`: `SidebarTrigger`, `Separator`, `AppBreadcrumb`, `ThemeToggle`, `ValuePrivacyToggle`, `Eye`, `EyeOff`, `Button`, and `useValuesHidden` (these now live in `AppTopBar` / `ValuePrivacyToggle`). Keep `Outlet`, `createRouter`, `createRoute`, `createRootRoute`, `redirect`.

Replace the `appLayoutRoute` component (the inline arrow returning the shell) with a reference to a new `AppLayout` component, and define `AppLayout` above `appLayoutRoute`:

```tsx
function AppLayout() {
  // PWA-mobile = installed standalone AND phone-width. Reuse both hooks inline
  // (no combined hook). In this mode the top bar is replaced by a bottom tab bar.
  const isPwaMobile = useIsPWA() && useIsMobile();
  return (
    <ValuesHiddenProvider>
      <TooltipProvider>
        <SidebarProvider>
          <AppSidebar />
          <SidebarInset>
            {isPwaMobile ? null : <AppTopBar />}
            {isPwaMobile ? (
              <div className="pb-[calc(4rem+env(safe-area-inset-bottom))]">
                <Outlet />
              </div>
            ) : (
              <Outlet />
            )}
            {isPwaMobile ? <PwaTabBar /> : null}
          </SidebarInset>
        </SidebarProvider>
      </TooltipProvider>
    </ValuesHiddenProvider>
  );
}
```

And set the route component:

```tsx
const appLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  beforeLoad: requireInitializedAndAuthed,
  component: AppLayout,
});
```

- [ ] **Step 2: Add the sidebar footer toggles (PWA-mobile only)**

In `apps/web/src/components/app-sidebar.tsx`, add imports:

```tsx
import { ThemeToggle } from "@/components/theme-toggle";
import { ValuePrivacyToggle } from "@/components/value-privacy-toggle";
import { useIsPWA } from "@/hooks/use-pwa";
import { useIsMobile } from "@/hooks/use-mobile";
```

Inside `AppSidebar()`, compute the gate:

```tsx
  const isPwaMobile = useIsPWA() && useIsMobile();
```

Replace the `<SidebarFooter>` block with:

```tsx
      <SidebarFooter>
        {isPwaMobile ? (
          <div className="flex items-center justify-end gap-1 px-1 pb-1">
            <ValuePrivacyToggle />
            <ThemeToggle />
          </div>
        ) : null}
        <NavUser user={user} />
      </SidebarFooter>
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/web && bun run build`
Expected: builds clean, no unused-import errors.

- [ ] **Step 4: Manual verification (PWA-mobile)**

Run the app: `bun run --cwd apps/web dev` (or the project's dev command). Then:
- In a normal desktop browser tab: confirm the top bar (breadcrumb + toggles) is unchanged and there is no bottom tab bar.
- Emulate mobile + standalone: open DevTools device toolbar (phone width) AND launch as an installed PWA (Chrome: Install app → open from the installed window). Confirm: no top bar; bottom tab bar with Home / Transactions / + / Assets / More; tapping a tab navigates and highlights; the center + opens the add-transaction drawer with an Account selector pre-filled to the last-used account; submitting creates the transaction; "More" opens the sidebar sheet showing the theme + privacy toggles in its footer.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/router.tsx apps/web/src/components/app-sidebar.tsx
git commit -m "feat: PWA-mobile layout — bottom tab bar, top bar hidden, toggles in sidebar"
```

---

### Task 9: Regression E2E (browser-mode unchanged)

**Files:** none (verification only)

Browser-mode layout is unchanged, so the existing specs must still pass. PWA-mobile UI cannot be emulated in Playwright (display-mode standalone is not settable), so it is intentionally not E2E-covered — it was verified manually in Task 8.

- [ ] **Step 1: Run the affected specs**

Run: `bun run e2e -- transactions.spec.ts accounts.spec.ts value-privacy.spec.ts sidebar.spec.ts`
Expected: all pass. These cover add-transaction from the account page (the refactored dialog in account mode), the privacy toggle, and the sidebar.

- [ ] **Step 2: Final full typecheck**

Run: `cd apps/web && bun run build`
Expected: builds clean.

- [ ] **Step 3: Commit (if any fixups were needed)**

```bash
git add -A
git commit -m "test: verify browser-mode layout unaffected by PWA changes"
```

(If no fixups were needed, skip this commit.)

---

## Self-Review notes

- **Spec coverage:** mode gate (Task 8, inline hooks per decision — no new hook); top bar removed + extracted (Tasks 4, 8); bottom tab bar 5 slots incl. center + (Task 7); breadcrumb gone in PWA (Task 8 hides `AppTopBar` which owns it); Assets stub + route + nav (Task 6); More opens sidebar (Task 7 `setOpenMobile`); toggles to sidebar in PWA (Tasks 3, 8); global add-transaction with last-used account (Tasks 1, 5); sync `useIsPWA` (Task 2). All covered.
- **Type consistency:** `resolveDefaultAccountId(txRows, accounts)` signature identical across Task 1 (def) and Task 5 (call). `AddTransactionDialog` props `{ accountId?, accountCurrency?, open?, onOpenChange?, showTrigger? }` consistent across Task 5 (def), Task 7 (`open`/`onOpenChange`/`showTrigger` call), and account-detail (`accountId`/`accountCurrency`, untouched). `isPwaMobile = useIsPWA() && useIsMobile()` identical in Task 8 router and sidebar.
- **`as any` ban:** no `as any` introduced; the only assertions are the pre-existing `as "buy" | "sell"` (specific) and `as const`.
