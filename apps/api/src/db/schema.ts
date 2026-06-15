import { sqliteTable, text, integer, uniqueIndex, primaryKey, index } from "drizzle-orm/sqlite-core";

export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey(), // always 1
  householdName: text("household_name").notNull(),
  baseCurrency: text("base_currency").notNull(),
  // Projection assumptions (slice 2). Both editable in Settings.
  contributionGrowthRateBps: integer("contribution_growth_rate_bps").notNull().default(800),
  projectionEndAge: integer("projection_end_age").notNull().default(90),
  // Ordered list of enabled dashboard tile ids, JSON-encoded. Per-household
  // (the singleton row). Default: Assets, Liabilities, Goals on track.
  dashboardTiles: text("dashboard_tiles").notNull().default('["assets","liabilities","goalsOnTrack"]'),
  // Smart import (AI). "AI enabled" iff aiBaseUrl AND aiModel are both set.
  // Single OpenAI-compatible provider (local or cloud). Key is never returned to the client.
  aiBaseUrl: text("ai_base_url"),
  aiModel: text("ai_model"),
  aiApiKey: text("ai_api_key"),
  createdAt: integer("created_at").notNull(),
});

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  class: text("class").$type<"asset" | "liability">().notNull(),
  subtype: text("subtype").notNull(),
  currency: text("currency").notNull(),
  institution: text("institution"),
  isArchived: integer("is_archived").notNull().default(0),
  sortOrder: integer("sort_order").notNull().default(0),
  // Projection assumptions (slice 1). Rates/haircuts in basis points.
  growthRateBps: integer("growth_rate_bps").notNull().default(0),
  accessibleFromAge: integer("accessible_from_age").notNull().default(0),
  earlyWithdrawal: text("early_withdrawal").$type<"none" | "penalty">().notNull().default("none"),
  earlyHaircutBps: integer("early_haircut_bps").notNull().default(0),
  illiquid: integer("illiquid").notNull().default(0),
  liquidationAge: integer("liquidation_age"),
  // Decumulation (withdrawals) for projections. 'none' = pure accumulation.
  spendType: text("spend_type", { enum: ["none", "once", "monthly", "percent"] })
    .notNull()
    .default("none"),
  spendAmountMinor: integer("spend_amount_minor"), // base minor: 'once' lump / 'monthly' per-month; null otherwise
  spendRateBps: integer("spend_rate_bps"),         // 'percent' annual % of balance (400 = 4%/yr); null otherwise
  spendStartKind: text("spend_start_kind", { enum: ["age", "target"] })
    .notNull()
    .default("age"),
  spendStartAge: integer("spend_start_age"),               // when spendStartKind = 'age'
  spendStartTargetMinor: integer("spend_start_target_minor"), // base minor; when spendStartKind = 'target'
  // Accumulation: monthly contribution (base minor) until contributionUntilAge
  // (null = whole projection), compounded at compoundInterval.
  contributionMinor: integer("contribution_minor").notNull().default(0),
  contributionUntilAge: integer("contribution_until_age"),
  compoundInterval: text("compound_interval", { enum: ["monthly", "quarterly", "annually"] })
    .notNull()
    .default("annually"),
  // Liabilities only: remaining loan term in months. null = no term set (held flat).
  loanTermMonths: integer("loan_term_months"),
  groupId: text("group_id"),   // nullable logical FK → groups.id
  createdAt: integer("created_at").notNull(),
  createdBy: text("created_by").notNull(),
});

export const groups = sqliteTable("groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  class: text("class").$type<"asset" | "liability">().notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: integer("created_at").notNull(),
});

export const instruments = sqliteTable("instruments", {
  id: text("id").primaryKey(),
  symbol: text("symbol"),
  isin: text("isin"),
  name: text("name").notNull(),
  kind: text("kind").$type<"currency" | "stock" | "etf" | "fund" | "crypto" | "other">().notNull(),
  currency: text("currency").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const transactions = sqliteTable("transactions", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  instrumentId: text("instrument_id").notNull(),
  date: text("date").notNull(), // YYYY-MM-DD, backdating allowed
  unitsDelta: integer("units_delta").notNull(), // signed, ×1e8 (positive = acquire, negative = dispose)
  unitPriceScaled: integer("unit_price_scaled"), // price per unit at trade time ×1e8 (SCALE for currencies)
  feesMinor: integer("fees_minor").notNull().default(0),
  notes: text("notes"),
  importBatchId: text("import_batch_id"), // nullable logical FK → import_batches.id (traceability)
  linkedTransactionId: text("linked_transaction_id"), // nullable FK → transactions.id (e.g. a buy/sell's cash leg)
  createdAt: integer("created_at").notNull(),
  createdBy: text("created_by").notNull(),
});

export const prices = sqliteTable("prices", {
  id: text("id").primaryKey(),
  instrumentId: text("instrument_id").notNull(),
  date: text("date").notNull(),
  priceScaled: integer("price_scaled").notNull(),
  source: text("source").notNull().default("manual"),
  createdAt: integer("created_at").notNull(),
}, (t) => [uniqueIndex("prices_instrument_date_uq").on(t.instrumentId, t.date)]);

export const fxRates = sqliteTable("fx_rates", {
  id: text("id").primaryKey(),
  currency: text("currency").notNull(),
  date: text("date").notNull(),
  rateScaled: integer("rate_scaled").notNull(),
  createdAt: integer("created_at").notNull(),
}, (t) => [uniqueIndex("fx_rates_currency_date_uq").on(t.currency, t.date)]);

// Many-to-many: which users own an account. >=1 owner per account.
// 1 owner = personal (counts in that member's net worth); 2+ = shared (household total only).
export const accountOwners = sqliteTable("account_owners", {
  accountId: text("account_id").notNull(), // FK -> accounts.id
  userId: text("user_id").notNull(),       // FK -> user.id
}, (t) => [
  primaryKey({ columns: [t.accountId, t.userId] }),
  index("account_owners_user_id_idx").on(t.userId),
]);

// One row per household member holding projection inputs that aren't on the auth user.
export const memberProfiles = sqliteTable("member_profiles", {
  userId: text("user_id").primaryKey(), // FK -> user.id
  birthYear: integer("birth_year"),
});

// Financial goals. Ordered/allocated by soonest targetDate then smallest amount;
// eligibility derives from targetDate. ownerScope is 'household' or a userId.
// anchorDate is the optional on-track baseline (null => anchor at createdAt).
// spend* model decumulation at/after targetDate (see lib/goals simulateGoals).
export const goals = sqliteTable("goals", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  targetAmountMinor: integer("target_amount_minor").notNull(),
  currency: text("currency").notNull(),
  targetDate: text("target_date"), // YYYY-MM-DD | null (null = indefinite, amount-only goal)
  ownerScope: text("owner_scope").notNull().default("household"),
  anchorDate: text("anchor_date"), // YYYY-MM-DD | null
  // Assumed planned saving toward this goal (base of the projected line).
  monthlyContributionMinor: integer("monthly_contribution_minor").notNull().default(0),
  // How this goal spends at/after targetDate. 'none' = pure accumulation.
  spendType: text("spend_type", { enum: ["none", "once", "monthly", "percent"] })
    .notNull()
    .default("none"),
  spendAmountMinor: integer("spend_amount_minor"), // 'once' lump / 'monthly' flat $; null otherwise
  spendRateBps: integer("spend_rate_bps"), // 'percent' annual % of balance (400 = 4%/yr); null otherwise
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  createdBy: text("created_by").notNull(),
});

// A reusable, user-editable declarative parser for a statement format.
// `config` and `fingerprint` are JSON strings (see lib/import/types.ts).
export const importParsers = sqliteTable("import_parsers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  sourceFormat: text("source_format").$type<"csv" | "ofx" | "qif" | "pdf">().notNull(),
  config: text("config").notNull(),
  fingerprint: text("fingerprint").notNull(),
  origin: text("origin").$type<"ai" | "manual">().notNull().default("manual"),
  createdAt: integer("created_at").notNull(),
  createdBy: text("created_by").notNull(),
});

// One per uploaded file. fileHash is stored for duplicate-upload detection
// (reserved; row-level dedup currently handles duplicates).
export const importBatches = sqliteTable("import_batches", {
  id: text("id").primaryKey(),
  parserId: text("parser_id").notNull(),  // logical FK → import_parsers.id
  accountId: text("account_id").notNull(),
  filename: text("filename").notNull(),
  fileHash: text("file_hash").notNull(),
  status: text("status").$type<"parsing" | "review" | "committed" | "discarded">().notNull(),
  rowCountNew: integer("row_count_new").notNull().default(0),
  rowCountDuplicate: integer("row_count_duplicate").notNull().default(0),
  rowCountError: integer("row_count_error").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  createdBy: text("created_by").notNull(),
});

// Staged canonical rows for a batch. `category` is reserved (Spec: ledger-only now).
export const importRows = sqliteTable("import_rows", {
  id: text("id").primaryKey(),
  batchId: text("batch_id").notNull(),  // FK → import_batches.id
  raw: text("raw").notNull(),           // JSON: original header→cell map
  date: text("date"),                   // YYYY-MM-DD | null (null => error row)
  amountMinor: integer("amount_minor"), // signed minor units | null
  description: text("description").notNull().default(""),
  category: text("category"),           // reserved, unused in v1
  dedupHash: text("dedup_hash").notNull(),
  status: text("status").$type<"new" | "duplicate" | "excluded" | "error">().notNull(),
  errorReason: text("error_reason"),
  matchedTxnId: text("matched_txn_id"),
  committedTxnId: text("committed_txn_id"),
}, (t) => [index("import_rows_batch_idx").on(t.batchId)]);

export * from "./auth-schema";
