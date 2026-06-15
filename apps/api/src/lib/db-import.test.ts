import { expect, test } from "bun:test";
import { isSqliteFile, IMPORT_TABLES } from "./db-import";

test("isSqliteFile detects the SQLite magic header", () => {
  const ok = new TextEncoder().encode("SQLite format 3 and the rest...");
  expect(isSqliteFile(ok)).toBe(true);
  expect(isSqliteFile(new TextEncoder().encode("not a database"))).toBe(false);
  expect(isSqliteFile(new Uint8Array(4))).toBe(false);
});

test("IMPORT_TABLES covers domain + auth tables", () => {
  for (const t of [
    "settings",
    "accounts",
    "groups",
    "instruments",
    "transactions",
    "prices",
    "fx_rates",
    "account_owners",
    "member_profiles",
    "goals",
    "user",
    "session",
    "account",
    "verification",
  ]) {
    expect(IMPORT_TABLES).toContain(t);
  }
});
