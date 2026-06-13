import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { settings, user } from "../db/schema";
import { eq } from "drizzle-orm";
import { auth } from "../auth";
import { isInitialized } from "../lib/settings";

export const onboarding = new Elysia({ prefix: "/onboarding" })
  .get("/status", async () => ({ initialized: await isInitialized() }))
  .post(
    "/init",
    async ({ body, set }) => {
      if (await isInitialized()) {
        set.status = 409;
        return { error: "already_initialized" };
      }

      // Create the first user via better-auth so the password is hashed correctly.
      // auth.api.signUpEmail returns { token, user } — user.id is available immediately.
      // This cannot live inside a Drizzle transaction because better-auth manages its own DB calls.
      let result;
      try {
        result = await auth.api.signUpEmail({
          body: { email: body.email, name: body.name, password: body.password },
          headers: new Headers(),
        });
      } catch {
        set.status = 422;
        return { error: "signup_failed" };
      }

      // Set isAdmin = true and insert the settings singleton.
      // If either write fails, delete the just-created user so the app stays re-initializable.
      try {
        // Set isAdmin = true via Drizzle (better-auth doesn't expose isAdmin on creation
        // because it's marked `input: false` in additionalFields).
        await db.update(user).set({ isAdmin: true }).where(eq(user.id, result.user.id));

        await db.insert(settings).values({
          id: 1,
          householdName: body.householdName,
          baseCurrency: body.baseCurrency.toUpperCase(),
          createdAt: Math.floor(Date.now() / 1000),
        });
      } catch {
        await db.delete(user).where(eq(user.id, result.user.id));
        set.status = 500;
        return { error: "init_failed" };
      }

      return { ok: true };
    },
    {
      body: t.Object({
        householdName: t.String({ minLength: 1 }),
        baseCurrency: t.String({ pattern: "^[A-Za-z]{3}$" }),
        email: t.String({ pattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$" }),
        name: t.String({ minLength: 1 }),
        password: t.String({ minLength: 8 }),
      }),
    },
  );
