import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { settings } from "../db/schema";

// Filesystem-safe slug of the household name. Lowercases, strips accents, and
// collapses any run of non-alphanumerics to a single hyphen. Falls back to
// "household" when the name is empty or has no usable characters.
export function slugifyHousehold(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // drop combining accent marks left by NFKD
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "household";
}

// Base filename for data exports: `uang-YYYY-MM-DD-<household-slug>`.
// The caller appends the extension (.db / .zip).
export async function exportBaseName(today: string): Promise<string> {
  const [s] = await db.select().from(settings).where(eq(settings.id, 1));
  return `uang-${today}-${slugifyHousehold(s?.householdName ?? "")}`;
}
