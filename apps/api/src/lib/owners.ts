import { db } from "../db/client";
import { accounts, accountOwners, user } from "../db/schema";
import { eq, inArray } from "drizzle-orm";

// All user ids that own a single account.
export async function getOwnersByAccount(accountId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: accountOwners.userId })
    .from(accountOwners)
    .where(eq(accountOwners.accountId, accountId));
  return rows.map((r) => r.userId);
}

// accountId -> [userId, ...] for every account that has owners. One query.
export async function getAllOwnerSets(): Promise<Map<string, string[]>> {
  const rows = await db.select().from(accountOwners);
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const arr = map.get(r.accountId) ?? [];
    arr.push(r.userId);
    map.set(r.accountId, arr);
  }
  return map;
}

// Replace an account's owner set wholesale. Dedupes; empty list clears owners.
export async function setOwners(accountId: string, userIds: string[]): Promise<void> {
  await db.delete(accountOwners).where(eq(accountOwners.accountId, accountId));
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return;
  await db.insert(accountOwners).values(unique.map((userId) => ({ accountId, userId })));
}

// One-time, idempotent: give every ownerless account its creator as sole owner.
// Safe on an empty DB and safe to run on every boot.
export async function backfillOwners(): Promise<void> {
  const accts = await db
    .select({ id: accounts.id, createdBy: accounts.createdBy })
    .from(accounts);
  if (accts.length === 0) return;
  const existing = await getAllOwnerSets();
  const missing = accts.filter((a) => !existing.has(a.id));
  if (missing.length === 0) return;
  await db.insert(accountOwners).values(missing.map((a) => ({ accountId: a.id, userId: a.createdBy })));
}

// True only when the list is non-empty and every (deduped) id is an existing user.
export async function allUsersExist(ids: string[]): Promise<boolean> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return false;
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .where(inArray(user.id, unique));
  return rows.length === unique.length;
}
