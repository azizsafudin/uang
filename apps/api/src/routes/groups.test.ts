import { expect, test, beforeEach } from "bun:test";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { groupsRoutes } from "./groups";
import { accountsRoutes } from "./accounts";
import { db } from "../db/client";
import { groups, accounts } from "../db/schema";
import { eq } from "drizzle-orm";

beforeEach(resetDb);

test("requires auth", async () => {
  const app = makeApp(groupsRoutes);
  const res = await app.handle(new Request("http://localhost/groups"));
  expect(res.status).toBe(401);
});

test("create and list groups", async () => {
  const app = makeApp(groupsRoutes);
  const { cookie } = await initAndLogin({ app });

  const create = await app.handle(
    new Request("http://localhost/groups", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "CPF", class: "asset" }),
    }),
  );
  expect(create.status).toBe(200);
  const { id } = await create.json();
  expect(id).toBeTruthy();

  const list = await app.handle(
    new Request("http://localhost/groups", { headers: { cookie } }),
  );
  const body = await list.json();
  expect(body.length).toBe(1);
  expect(body[0].name).toBe("CPF");
  expect(body[0].class).toBe("asset");
});

test("rename a group", async () => {
  const app = makeApp(groupsRoutes);
  const { cookie } = await initAndLogin({ app });

  const create = await app.handle(
    new Request("http://localhost/groups", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "CPF", class: "asset" }),
    }),
  );
  const { id } = await create.json();

  const patch = await app.handle(
    new Request(`http://localhost/groups/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "CPF Accounts" }),
    }),
  );
  expect(patch.status).toBe(200);

  const [row] = await db.select().from(groups).where(eq(groups.id, id));
  expect(row.name).toBe("CPF Accounts");
});

test("delete group nullifies groupId on member accounts", async () => {
  // NOTE: The accounts POST route does not yet accept groupId in its body schema
  // (that is Task 4). To make this test meaningfully exercise the delete-nullify
  // behaviour, we create the group and account via the API, then directly set
  // the account's groupId via a DB update before triggering the delete.
  const app = makeApp(groupsRoutes, accountsRoutes);
  const { cookie } = await initAndLogin({ app });

  const gRes = await app.handle(
    new Request("http://localhost/groups", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "CPF", class: "asset" }),
    }),
  );
  const { id: groupId } = await gRes.json();

  const aRes = await app.handle(
    new Request("http://localhost/accounts", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        name: "CPF OA",
        class: "asset",
        subtype: "bank",
        currency: "SGD",
      }),
    }),
  );
  expect(aRes.status).toBe(200);
  const { id: accountId } = await aRes.json();

  // Directly wire the account to the group so the delete-nullify path is exercised.
  await db.update(accounts).set({ groupId }).where(eq(accounts.id, accountId));

  // Confirm the groupId is set before deletion.
  const [before] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  expect(before.groupId).toBe(groupId);

  await app.handle(
    new Request(`http://localhost/groups/${groupId}`, {
      method: "DELETE",
      headers: { cookie },
    }),
  );

  const [acct] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  expect(acct).toBeTruthy();
  expect(acct.groupId).toBeNull();

  const remaining = await db.select().from(groups);
  expect(remaining.length).toBe(0);
});
