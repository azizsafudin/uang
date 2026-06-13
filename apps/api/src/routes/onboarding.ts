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
      const result = await auth.api.signUpEmail({
        body: { email: body.email, name: body.name, password: body.password },
        headers: new Headers(),
      });

      // Set isAdmin = true via Drizzle (better-auth doesn't expose isAdmin on creation
      // because it's marked `input: false` in additionalFields).
      await db.update(user).set({ isAdmin: true }).where(eq(user.id, result.user.id));

      await db.insert(settings).values({
        id: 1,
        householdName: body.householdName,
        baseCurrency: body.baseCurrency.toUpperCase(),
        createdAt: Math.floor(Date.now() / 1000),
      });

      return { ok: true };
    },
    {
      body: t.Object({
        householdName: t.String({ minLength: 1 }),
        baseCurrency: t.String({ minLength: 3, maxLength: 3 }),
        email: t.String(),
        name: t.String({ minLength: 1 }),
        password: t.String({ minLength: 8 }),
      }),
    },
  );
