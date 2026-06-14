// Detects a SQLite/libsql UNIQUE-or-PRIMARY-KEY constraint violation, so write
// routes that accept a client-supplied id can answer a clean 409 instead of a 500
// when that id already exists. drizzle wraps the driver error in a
// DrizzleQueryError, so we walk the `cause` chain (code/message live on the cause).
export function isUniqueViolation(err: unknown): boolean {
  let e: { code?: unknown; message?: unknown; cause?: unknown } | undefined =
    err as { code?: unknown; message?: unknown; cause?: unknown } | undefined;
  while (e) {
    if (typeof e.code === "string" && e.code.startsWith("SQLITE_CONSTRAINT")) return true;
    if (typeof e.message === "string" && e.message.includes("UNIQUE constraint failed")) return true;
    e = e.cause as typeof e;
  }
  return false;
}
