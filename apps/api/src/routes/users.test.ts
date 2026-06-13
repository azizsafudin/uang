import { expect, test, beforeEach } from "bun:test";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { usersRoutes } from "./users";

beforeEach(resetDb);

test("admin can invite a user; the new user is not admin and can sign in", async () => {
  const app = makeApp(usersRoutes);
  const { cookie } = await initAndLogin({ app });

  // Admin invites a new member
  const res = await app.handle(
    new Request("http://localhost/users", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        email: "member@test.com",
        name: "Member",
        password: "anothersecret1",
      }),
    }),
  );
  expect(res.status).toBe(200);

  // List users — member should appear with isAdmin=false
  const list = await (
    await app.handle(
      new Request("http://localhost/users", { headers: { cookie } }),
    )
  ).json();
  expect(list.find((u: any) => u.email === "member@test.com")).toBeTruthy();
  expect(
    list.find((u: any) => u.email === "member@test.com").isAdmin,
  ).toBe(false);

  // Member can sign in via the auth endpoint
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
  expect(signin.status).toBe(200);
});

test("non-admin cannot invite users (403)", async () => {
  const app = makeApp(usersRoutes);
  const { cookie: adminCookie } = await initAndLogin({ app });

  // Invite a member first (as admin)
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

  // Sign in as member (non-admin)
  const signinRes = await app.handle(
    new Request("http://localhost/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "member@test.com",
        password: "anothersecret1",
      }),
    }),
  );
  const memberCookie = signinRes.headers.get("set-cookie") ?? "";

  // Member attempts to invite another user — should get 403
  const res = await app.handle(
    new Request("http://localhost/users", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: memberCookie },
      body: JSON.stringify({
        email: "another@test.com",
        name: "Another",
        password: "anothersecret1",
      }),
    }),
  );
  expect(res.status).toBe(403);
});

test("unauthenticated requests to GET /users return 401", async () => {
  const app = makeApp(usersRoutes);
  const res = await app.handle(new Request("http://localhost/users"));
  expect(res.status).toBe(401);
});
