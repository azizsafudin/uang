# CSV Export & `.db` Import — Design

**Date:** 2026-06-15
**Status:** Approved (pending spec review)

## Summary

Two independent additions to the existing data-portability feature in uang:

- **A. Readable CSV export** — a `.zip` of denormalized, human-friendly CSVs (decimal values, names instead of internal IDs). Export-only; never round-tripped back in.
- **B. `.db` import (restore)** — an admin uploads a uang `.db` file; the server validates it, the user is forced to download a backup of current data first, then the database is replaced verbatim.

The existing `.db` export (`GET /export`, `VACUUM INTO` + binary download) stays exactly as-is and remains the **lossless** backup/migration artifact. CSV is purely for "import elsewhere" and "human-readable backup"; re-import into uang always rides on the `.db` file.

## Background

Today the only export is `GET /export` (in `apps/api/src/routes/export.ts`), which does `VACUUM INTO` a temp file and streams the raw SQLite database as `application/octet-stream`. There is no import. The settings page (`apps/web/src/routes/settings.tsx`, "Backup" section) links to `/export`.

uang is a single-household, multi-user app sharing one SQLite/libsql database. Domain data is entangled with auth user IDs: `accountOwners.user_id`, `accounts.created_by`, `transactions.created_by`, `memberProfiles.user_id`, and `goals.owner_scope`/`created_by` all reference `user.id`. The DB client (`apps/api/src/db/client.ts`) is a module singleton over `@libsql/client`, URL from `DATABASE_URL` (defaults to `file:./data/uang.db`; may be a remote libsql URL in deployment).

All monetary/quantity values are fixed-point scaled integers (`SCALE = 1e8` from `packages/shared`).

## Decisions

These were settled during brainstorming:

- **Use cases:** migrate/re-import, import elsewhere, human-readable backup.
- **CSV shape:** readable/denormalized only (no raw per-table CSV mode). The `.db` covers lossless needs.
- **Packaging:** ZIP of CSVs (no JSON, no XLSX).
- **Re-import:** `.db`-only. CSV is never re-imported.
- **CSV entities:** core ledger (accounts, transactions) + computed holdings + goals & settings. **No** market data (prices, fx_rates).
- **Import + auth:** **full verbatim replace** of all tables including auth — domain-only would orphan the user-ID FKs listed above and break per-member features. The file being restored is the user's own data, so their login survives the replace.
- **Import safety:** admin-only, validate before touching anything, **force a user-facing backup download before the destructive step**, plus a server-side auto-backup as defense-in-depth.

## A. Readable CSV export

### Endpoint
`GET /export/csv` (added in `apps/api/src/routes/export.ts`, behind the existing `authGuard`). Returns a `.zip` with:

```
content-type: application/zip
content-disposition: attachment; filename="uang-csv-YYYY-MM-DD.zip"
```

### Zip contents

Each entity is serialized by a small per-entity function that joins in names and converts scaled ints to decimals. No internal IDs in the output.

- **accounts.csv** — `name, class, subtype, currency, institution, group, archived, growth_rate_pct, accessible_from_age, early_withdrawal, illiquid, liquidation_age`. `group` is the group name (blank if none). `growth_rate_pct` is `growth_rate_bps / 100`.
- **transactions.csv** — `date, account, instrument_symbol, instrument_name, units, unit_price, fees, notes`. `account` = account name; `units` = `units_delta / 1e8` (signed); `unit_price` = `unit_price_scaled / 1e8`; `fees` = `fees_minor` as decimal in the account/instrument currency.
- **holdings.csv** — computed current position per account/instrument: `account, instrument_symbol, instrument_name, units, current_value, currency`. Reuses the existing holdings computation (the same logic that powers the holdings UI); does **not** reimplement valuation.
- **goals.csv** — `name, target_amount, currency, target_date, monthly_contribution, owner, spend_type, spend_amount, spend_rate_pct`. `owner` = member display name when `owner_scope` is a userId, else `"household"`.
- **settings.csv** — single data row: `household_name, base_currency, contribution_growth_rate_pct, projection_end_age`.

### Implementation notes

- **Serializer layer:** a new module (e.g. `apps/api/src/lib/csv-export.ts`) with one pure function per entity returning a `string` (CSV text) given already-fetched rows + lookup maps. Keep DB queries in the route or a thin loader; keep formatting pure and unit-testable.
- **CSV encoding:** RFC-4180-style — quote fields containing comma/quote/newline, double interior quotes. A tiny local helper, not a heavyweight dep.
- **Decimals:** format scaled ints by dividing by `SCALE` and trimming trailing zeros; no locale/thousands separators (machine-friendly).
- **Zipping:** prefer a no-dep approach; if Bun's runtime lacks a usable zip primitive, add one small, well-maintained zip dependency. Decide concretely in the implementation plan.
- **Holdings reuse:** import the existing holdings/valuation function rather than duplicating it. Identify the canonical source during planning.

## B. `.db` import (restore)

### Endpoint
`POST /import` (added behind `authGuard`, **admin-only** via `isAdmin` from the guard). Accepts a multipart file upload of a uang `.db`.

### Server flow
1. **Authorize:** reject non-admin with 403.
2. **Stage:** write the uploaded bytes to a temp file; open it as a second `@libsql/client` connection.
3. **Validate (before touching live data):**
   - SQLite magic header (`"SQLite format 3\0"`).
   - Presence of uang's expected tables (at minimum `accounts`, `settings`, `user`).
   - On failure → `400` with a clear message; live DB untouched.
4. **Auto-backup (defense-in-depth):** `VACUUM INTO /tmp/uang-pre-import-<timestamp>.db` on the live DB.
5. **Replace verbatim (row-copy, URL-agnostic):** in a transaction with FK enforcement disabled (`PRAGMA foreign_keys = OFF`), for every known table: `DELETE FROM <table>` then bulk-`INSERT` the rows read from the staged upload. Row-copy (not file-swap) so it works whether the live DB is a local file or a remote libsql URL, and keeps the singleton connection valid.
6. **Respond:** `200`. Sessions were replaced, so the client redirects to `/login`.

### Notes / risks
- Full replace overwrites the `session` table → everyone is signed out; the importing admin logs back in with credentials from the restored DB (present because it's their own data). OAuth and email/password both survive because their secrets live in the restored `user`/`account` rows.
- Table list for delete/insert must be derived from the Drizzle schema (single source of truth) and ordered so the disabled-FK delete/insert is safe.
- Large DBs: batch inserts to avoid oversized statements.

## UI (settings page, "Backup" section)

`apps/web/src/routes/settings.tsx`:

- **Export as CSV (.zip):** a button next to the existing "Export database (.db)" button, linking to `${API_URL}/export/csv`.
- **Restore from backup (admin-only):** a new subsection, rendered only when the current user is an admin. Two-step, gated flow:
  1. **Step 1 — Download current backup (.db):** a button that triggers the existing `.db` export. This is a **hard gate** — Step 2 stays disabled until the user has performed this download in the current session.
  2. **Step 2 — Choose `.db` to restore:** file picker (enabled only after Step 1) → a destructive-action confirm dialog ("This replaces ALL data and signs everyone out. Continue?") → `POST /import` (multipart). On success, redirect to `/login`. On `400`/`403`, show the error inline.

## Testing

- **CSV export:**
  - Authenticated request → `200`, `content-type: application/zip`, correct filename.
  - Zip contains exactly the expected `.csv` entries.
  - A known fixture row serializes with correct decimal conversion (scaled int → decimal) and joined names (account/group/instrument/owner).
  - CSV-escaping unit tests (comma, quote, newline in `notes`/`name`).
- **`.db` import:**
  - Non-admin → `403`.
  - Garbage / non-uang SQLite file → `400`, live DB unchanged.
  - Round-trip: export `.db` → import into a fresh DB → table row counts and sampled values match the source.
  - Auto-backup file is created before replace.

## Out of scope

- CSV re-import (explicitly `.db`-only).
- Raw per-table CSV mode.
- JSON / XLSX export formats.
- Market-data CSVs (prices, fx_rates).
- Domain-only / selective import or user-ID remapping.
