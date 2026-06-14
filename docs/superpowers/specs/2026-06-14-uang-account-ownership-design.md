# Uang — Account Ownership & By-Owner Net Worth (design)

**Date:** 2026-06-14
**Status:** Draft for review
**Builds on:** the merged foundation + Plan 2 (accounts, ledger, FX, net-worth headline). This is a new slice not covered by the original spec.

---

## 1. Goal

Let the household see net worth from different vantage points: the **whole household**, or an **individual member**. Accounts carry one or more owners; an account owned by a single member counts toward that member's personal net worth, while an account with multiple owners is **shared** and contributes only to the household total.

After this slice you can:
- Assign one or more owners to each account (default: the person who created it).
- Change an account's owners later.
- Toggle the net-worth headline between **Household** and each **member**.
- See, on every account, who owns it and whether it's shared.

## 2. Scope

**In scope:** the `account_owners` join table + backfill; owners in account create/list; an edit-owners endpoint; the net-worth owner filter; a dashboard view toggle (headline only); an owners picker in the account form; owner display + inline edit on the account detail page.

**Out of scope / deferred:** per-owner *shares* of a shared account (we never split; shared accounts are simply excluded from individuals and included whole in the household total); per-account read/write permissions (all members remain equal and can edit anything — unchanged); applying the owner filter to the (future) net-worth-over-time graph (that graph is a later slice and will reuse this same filter).

## 3. Data model

A many-to-many relation between accounts and users:

```
account_owners
  account_id  text  -- FK -> accounts.id
  user_id     text  -- FK -> user.id
  PRIMARY KEY (account_id, user_id)
  -- index on (user_id)
```

An account has **≥1** owner. The relation is unordered and unweighted (no "primary owner", no percentage).

**Backfill (one-time, idempotent):** for every existing account with no rows in `account_owners`, insert `(account.id, account.created_by)`. Runs after migrations on API boot, guarded so it only inserts where missing — safe to run repeatedly and safe on an empty DB.

## 4. Ownership rule (the one invariant)

For an account with owner set `O`:
- `|O| == 1` → the account is **personal** to that single member; it counts in that member's individual net worth and in the household total.
- `|O| >= 2` → the account is **shared**; it is **excluded from every individual's** net worth and counts only in the **household** total.

`shared = |O| >= 2`. There is no splitting and no partial attribution.

## 5. API

- **`GET /accounts`** — each account gains `ownerIds: string[]`.
- **`POST /accounts`** — accepts optional `ownerIds: string[]`. If omitted or empty, defaults to `[creatorUserId]`. Owner ids must be existing users (invalid ids rejected 422).
- **`PATCH /accounts/:id/owners`** — body `{ ownerIds: string[] }` (must be non-empty; all must be existing users). Replaces the account's owner set.
- **`GET /networth?owner=`** — `owner` is `household` (default when absent) or a `userId`:
  - `household` → all non-archived accounts.
  - `<userId>` → only non-archived accounts whose owner set is exactly `{ userId }` (personal to that member). Shared and other-member accounts excluded.
  - Response unchanged in shape, plus each account entry includes `ownerIds: string[]` and `shared: boolean`. `totalBaseMinor` reflects the filtered set; the per-account `accounts[]` array reflects the **filtered** set (the dashboard sources the full list separately — see §6).

All endpoints remain behind the existing `authGuard`.

## 6. UI

**Dashboard**
- A **view toggle** sits above the net-worth hero: `Household` plus one option per household member (names from `GET /users`). It controls only the **headline** `totalBaseMinor`, fetched via `GET /networth?owner=<selection>`.
- The **account list always shows all accounts** (sourced from the accounts collection, independent of the toggle), grouped assets/liabilities as today. Each row shows the owner(s): a member's name for personal accounts, or a **"Shared"** badge (with owner names) for shared ones.
- Default selection: `Household`.

**Account form (create)**
- An **Owners** field: a checkbox list of household members (from `GET /users`), with the current user pre-checked. At least one required. Selecting two or more marks the account shared. `ownerIds` is sent on create.

**Account detail**
- Shows the owner(s) and a "Shared" badge when applicable, with an inline editor (the same checkbox list) that calls `PATCH /accounts/:id/owners`. Changing owners refetches accounts + net worth.

## 7. Components / boundaries

- `account_owners` schema + a small `owners` lib on the API (`getOwnersByAccount()`, `setOwners(accountId, ids)`, `backfillOwners()`).
- `valuation.ts` `netWorth(opts)` gains an `owner` option and consults the owner sets; the personal/shared rule lives here, tested in isolation.
- Web: an `OwnersField` component (checkbox list) reused by the create form and the detail editor; a `NetWorthToggle` component on the dashboard.

## 8. Testing

- **Valuation (unit):** household sums all; a member's view includes only their sole-owned accounts and excludes shared and other-member accounts; `shared` flag correctness at `|O|` = 1 vs 2.
- **Backfill (unit):** existing ownerless accounts get `created_by`; idempotent on re-run; no-op on empty DB.
- **Routes:** create with explicit `ownerIds` and with default; `GET /accounts` returns `ownerIds`; `PATCH /owners` replaces and rejects empty/invalid; `GET /networth?owner=` filters correctly and 401 without auth.
- **Web:** build is the gate; manual E2E for the toggle and owners editing.

## 9. Defaults / open items

- **Edit owners:** included (PATCH endpoint + detail editor).
- **Default owner on create:** the creating user.
- **Account list:** always shows all accounts regardless of the toggle; only the headline changes.
- **Members list source:** `GET /users` (already exists).
