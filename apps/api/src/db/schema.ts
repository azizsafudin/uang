import { sqliteTable, text, integer, uniqueIndex, primaryKey, index } from "drizzle-orm/sqlite-core";

export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey(), // always 1
  householdName: text("household_name").notNull(),
  baseCurrency: text("base_currency").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  class: text("class").$type<"asset" | "liability">().notNull(),
  subtype: text("subtype").notNull(),
  currency: text("currency").notNull(),
  valuationMode: text("valuation_mode").$type<"ledger" | "holdings">().notNull(),
  institution: text("institution"),
  isArchived: integer("is_archived").notNull().default(0),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  createdBy: text("created_by").notNull(),
});

export const entries = sqliteTable("entries", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  date: text("date").notNull(), // YYYY-MM-DD
  amountMinor: integer("amount_minor").notNull(),
  kind: text("kind").notNull(), // 'opening'|'adjustment'|'revaluation'|'transaction'
  note: text("note"),
  createdAt: integer("created_at").notNull(),
  createdBy: text("created_by").notNull(),
});

export const instruments = sqliteTable("instruments", {
  id: text("id").primaryKey(),
  symbol: text("symbol"),
  isin: text("isin"),
  name: text("name").notNull(),
  kind: text("kind").$type<"stock" | "etf" | "fund" | "other">().notNull(),
  currency: text("currency").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const lots = sqliteTable("lots", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  instrumentId: text("instrument_id").notNull(),
  unitsScaled: integer("units_scaled").notNull(),
  unitCostScaled: integer("unit_cost_scaled").notNull(),
  feesMinor: integer("fees_minor").notNull().default(0),
  tradeDate: text("trade_date").notNull(),
  note: text("note"),
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

export * from "./auth-schema";
