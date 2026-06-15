import { createHash } from "node:crypto";

export function normalizeDescription(d: string): string {
  return d.trim().toLowerCase().replace(/\s+/g, " ");
}

export function dedupHash(
  accountId: string,
  row: { date: string; amountMinor: number; description: string },
): string {
  const key = [accountId, row.date, String(row.amountMinor), normalizeDescription(row.description)].join("|");
  return createHash("sha256").update(key).digest("hex");
}
