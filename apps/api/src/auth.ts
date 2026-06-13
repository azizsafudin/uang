import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "./db/client";

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "sqlite" }),
  emailAndPassword: {
    enabled: true,
    // Open sign-up is gated by the onboarding flow + an admin-only invite path
    // (enforced in routes). better-auth itself allows sign-up; we wrap it.
  },
  user: {
    additionalFields: {
      isAdmin: { type: "boolean", required: false, defaultValue: false, input: false },
    },
  },
  trustedOrigins: [process.env.WEB_ORIGIN ?? "http://localhost:5173"],
  secret: process.env.BETTER_AUTH_SECRET ?? "dev-secret",
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
});
