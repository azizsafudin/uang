process.env.DATABASE_URL = ":memory:";

// Run migrations once for the whole suite. The in-memory DB is a module-level
// singleton that lives for the entire process, so the schema persists across
// every test file — `resetDb` only needs to clear rows, not re-migrate.
// Dynamic import so it runs AFTER DATABASE_URL is set above (a static import
// would be hoisted and evaluate db/client against the default file URL).
const { runMigrations } = await import("./db/migrate");
await runMigrations();
