import type { Client, InValue, InStatement } from "@libsql/client";

// Every table whose rows are replaced verbatim on import (domain + auth).
// Order is irrelevant: FK enforcement is disabled around the row copy.
export const IMPORT_TABLES = [
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
] as const;

// SQLite files begin with the 16-byte string "SQLite format 3\0".
export function isSqliteFile(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  return new TextDecoder().decode(bytes.subarray(0, 15)) === "SQLite format 3";
}

// Confirms the uploaded DB looks like a uang database before we touch live data.
export async function validateUpload(
  src: Client,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await src.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  );
  const names = new Set(res.rows.map((r) => String(r["name"])));
  for (const required of ["accounts", "settings", "user"]) {
    if (!names.has(required)) {
      return { ok: false, error: "not_a_uang_db" };
    }
  }
  return { ok: true };
}

// Replaces all known tables in `dst` with the rows from `src`, atomically.
// FK enforcement is turned off around the batch so delete/insert order is moot.
export async function replaceAllData(src: Client, dst: Client): Promise<void> {
  const stmts: InStatement[] = [];
  for (const table of IMPORT_TABLES) {
    stmts.push({ sql: `DELETE FROM "${table}"` });
    const res = await src.execute(`SELECT * FROM "${table}"`);
    const cols = res.columns;
    if (cols.length === 0) continue;
    const colList = cols.map((c) => `"${c}"`).join(", ");
    const placeholders = cols.map(() => "?").join(", ");
    for (const row of res.rows) {
      const args: InValue[] = cols.map((_, i) => row[i] as InValue);
      stmts.push({
        sql: `INSERT INTO "${table}" (${colList}) VALUES (${placeholders})`,
        args,
      });
    }
  }
  await dst.execute("PRAGMA foreign_keys = OFF");
  await dst.batch(stmts, "write");
  await dst.execute("PRAGMA foreign_keys = ON");
}
