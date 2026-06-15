import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "./db/client";

function isValidHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const u = new URL(value);
    return (u.protocol === "http:" || u.protocol === "https:") && u.host.length > 0;
  } catch {
    return false;
  }
}

// The single-service deploy intentionally does NOT hard-wire a public URL: on
// Railway, `RAILWAY_PUBLIC_DOMAIN` is empty in template deploys (a known Railway
// bug), so `BETTER_AUTH_URL=https://${{ RAILWAY_PUBLIC_DOMAIN }}` would collapse
// to "https://". Instead we let better-auth infer the base URL from the request
// (the app and API share one origin), and treat BETTER_AUTH_URL as an *optional*
// override for custom domains. better-auth reads BETTER_AUTH_URL straight from
// process.env, so an invalid value must be removed there — not just omitted from
// options — or it picks it up and crash-loops on "Invalid base URL".
if (process.env.BETTER_AUTH_URL && !isValidHttpUrl(process.env.BETTER_AUTH_URL)) {
  delete process.env.BETTER_AUTH_URL;
}
// Valid override → use it; otherwise infer from the request in production
// (same-origin) and fall back to localhost in dev.
const baseURL = isValidHttpUrl(process.env.BETTER_AUTH_URL)
  ? process.env.BETTER_AUTH_URL
  : process.env.NODE_ENV === "production"
    ? undefined
    : "http://localhost:3000";

const configuredWebOrigin = process.env.WEB_ORIGIN ?? "http://localhost:5173";
// Trust the configured web origin when valid; otherwise trust the request's own
// origin. The latter only ever matches same-origin requests (the Origin header
// of a cross-site request differs from the server's host), so it's safe.
// better-auth may invoke this with no request during init, so guard for it.
const trustedOrigins = isValidHttpUrl(configuredWebOrigin)
  ? [configuredWebOrigin]
  : (request: Request) => {
      try {
        return [new URL(request?.url ?? "").origin];
      } catch {
        return [];
      }
    };

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
  trustedOrigins,
  secret: process.env.BETTER_AUTH_SECRET ?? "dev-secret",
  baseURL,
  advanced: {
    // Serve session cookies only over HTTPS in production.
    useSecureCookies: process.env.NODE_ENV === "production",
  },
});
