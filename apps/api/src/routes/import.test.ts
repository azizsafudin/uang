import { expect, test, beforeEach } from "bun:test";
import { readdirSync } from "node:fs";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { importRoutes } from "./import";
import { exportRoutes } from "./export";
import { accountsRoutes } from "./accounts";
import { usersRoutes } from "./users";

beforeEach(resetDb);

function dummyDbForm() {
  const fd = new FormData();
  fd.append("file", new File(["SQLite format 3 junk"], "x.db"));
  return fd;
}

test("requires auth (401)", async () => {
  const app = makeApp(importRoutes);
  const res = await app.handle(
    new Request("http://localhost/import", {
      method: "POST",
      body: dummyDbForm(),
    }),
  );
  expect(res.status).toBe(401);
});

test("non-admin is forbidden (403)", async () => {
  const app = makeApp(importRoutes, usersRoutes);
  const { cookie: adminCookie } = await initAndLogin({ app });

  await app.handle(
    new Request("http://localhost/users", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({
        email: "member@test.com",
        name: "Member",
        password: "anothersecret1",
      }),
    }),
  );
  const signin = await app.handle(
    new Request("http://localhost/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "member@test.com",
        password: "anothersecret1",
      }),
    }),
  );
  const memberCookie = signin.headers.get("set-cookie") ?? "";

  const res = await app.handle(
    new Request("http://localhost/import", {
      method: "POST",
      headers: { cookie: memberCookie },
      body: dummyDbForm(),
    }),
  );
  expect(res.status).toBe(403);
});

test("rejects a non-SQLite upload (400)", async () => {
  const app = makeApp(importRoutes);
  const { cookie } = await initAndLogin({ app });
  const fd = new FormData();
  fd.append("file", new File(["not a database at all"], "x.db"));
  const res = await app.handle(
    new Request("http://localhost/import", {
      method: "POST",
      headers: { cookie },
      body: fd,
    }),
  );
  expect(res.status).toBe(400);
});

test("round-trip: export then import restores deleted data, writes a backup", async () => {
  const app = makeApp(accountsRoutes, exportRoutes, importRoutes);
  const { cookie } = await initAndLogin({ app });

  await app.handle(
    new Request("http://localhost/accounts", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        name: "Checking",
        class: "asset",
        subtype: "bank",
        currency: "USD",
      }),
    }),
  );

  const snapshot = await (
    await app.handle(
      new Request("http://localhost/export", { headers: { cookie } }),
    )
  ).arrayBuffer();

  const list = await (
    await app.handle(
      new Request("http://localhost/accounts", { headers: { cookie } }),
    )
  ).json();
  // The accounts route requires an account be archived before it can be
  // hard-deleted, so archive first, then delete to remove the row entirely.
  await app.handle(
    new Request(`http://localhost/accounts/${list[0].id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ isArchived: true }),
    }),
  );
  await app.handle(
    new Request(`http://localhost/accounts/${list[0].id}`, {
      method: "DELETE",
      headers: { cookie },
    }),
  );
  const mid = await (
    await app.handle(
      new Request("http://localhost/accounts", { headers: { cookie } }),
    )
  ).json();
  expect(mid.length).toBe(0);

  const backupsBefore = readdirSync("/tmp").filter((f) =>
    f.startsWith("uang-pre-import-"),
  ).length;

  const fd = new FormData();
  fd.append("file", new File([snapshot], "u.db"));
  const imp = await app.handle(
    new Request("http://localhost/import", {
      method: "POST",
      headers: { cookie },
      body: fd,
    }),
  );
  expect(imp.status).toBe(200);

  const backupsAfter = readdirSync("/tmp").filter((f) =>
    f.startsWith("uang-pre-import-"),
  ).length;
  expect(backupsAfter).toBeGreaterThan(backupsBefore);

  // cookie's session row was captured in the snapshot, so it is valid again.
  const after = await (
    await app.handle(
      new Request("http://localhost/accounts", { headers: { cookie } }),
    )
  ).json();
  expect(after.length).toBe(1);
  expect(after[0].name).toBe("Checking");
});
