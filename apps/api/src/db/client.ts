import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";

const url = process.env.DATABASE_URL ?? "file:./data/uang.db";
export const sqlite = createClient({ url });
export const db = drizzle(sqlite, { schema });
export type DB = typeof db;
