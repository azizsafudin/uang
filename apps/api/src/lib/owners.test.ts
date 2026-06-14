import { expect, test, beforeEach } from "bun:test";
import { resetDb } from "./test-helpers";
import { db } from "../db/client";
import { accounts, accountOwners, user } from "../db/schema";
import { createId, nowEpoch } from "./ids";
import {
  getOwnersByAccount,
  getAllOwnerSets,
  setOwners,
  backfillOwners,
  allUsersExist,
} from "./owners";

beforeEach(resetDb);

async function addUser(id: string) {
  await db.insert(user).values({
    id, name: `U${id}`, email: `${id}@t.com`, emailVerified: true,
    createdAt: new Date(), updatedAt: new Date(),
  } as any);
}

async function addAccount(createdBy: string) {
  const id = createId();
  await db.insert(accounts).values({
    id, name: "A", class: "asset", subtype: "bank", currency: "USD",
    valuationMode: "ledger", isArchived: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy,
  });
  return id;
}

test("setOwners then getOwnersByAccount round-trips and dedupes", async () => {
  await addUser("u1");
  await addUser("u2");
  const a = await addAccount("u1");
  await setOwners(a, ["u1", "u2", "u1"]); // duplicate u1
  const owners = (await getOwnersByAccount(a)).sort();
  expect(owners).toEqual(["u1", "u2"]);
});

test("setOwners replaces the prior owner set", async () => {
  await addUser("u1");
  await addUser("u2");
  const a = await addAccount("u1");
  await setOwners(a, ["u1", "u2"]);
  await setOwners(a, ["u2"]);
  expect(await getOwnersByAccount(a)).toEqual(["u2"]);
});

test("getAllOwnerSets groups owners by account", async () => {
  await addUser("u1");
  await addUser("u2");
  const a = await addAccount("u1");
  const b = await addAccount("u2");
  await setOwners(a, ["u1", "u2"]);
  await setOwners(b, ["u2"]);
  const map = await getAllOwnerSets();
  expect([...(map.get(a) ?? [])].sort()).toEqual(["u1", "u2"]);
  expect(map.get(b)).toEqual(["u2"]);
});

test("backfillOwners assigns created_by to ownerless accounts, is idempotent, no-ops on empty DB", async () => {
  await backfillOwners(); // empty DB: no throw, no rows
  expect((await getAllOwnerSets()).size).toBe(0);

  await addUser("u1");
  const a = await addAccount("u1");
  await backfillOwners();
  expect(await getOwnersByAccount(a)).toEqual(["u1"]);

  // Re-run is idempotent: still exactly one owner.
  await backfillOwners();
  expect(await getOwnersByAccount(a)).toEqual(["u1"]);

  // An account that already has owners is left untouched by backfill.
  await addUser("u2");
  await setOwners(a, ["u2"]);
  await backfillOwners();
  expect(await getOwnersByAccount(a)).toEqual(["u2"]);
});

test("allUsersExist is true only when every id exists and the list is non-empty", async () => {
  await addUser("u1");
  await addUser("u2");
  expect(await allUsersExist([])).toBe(false);
  expect(await allUsersExist(["u1", "u2"])).toBe(true);
  expect(await allUsersExist(["u1", "nope"])).toBe(false);
});
