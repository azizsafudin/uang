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

// The single-service deploy intentionally does NOT hard-wire a public URL via a
// derived template variable: on Railway, `BETTER_AUTH_URL=https://${{ RAILWAY_PUBLIC_DOMAIN }}`
// is resolved once at deploy time and frozen — and RAILWAY_PUBLIC_DOMAIN is
// often empty during a template deploy (a known Railway race), collapsing it to
// "https://", which crash-loops better-auth. better-auth also reads
// BETTER_AUTH_URL straight from process.env, so an invalid value must be removed
// there — not just omitted from options — or it picks it up and crashes.
if (process.env.BETTER_AUTH_URL && !isValidHttpUrl(process.env.BETTER_AUTH_URL)) {
  delete process.env.BETTER_AUTH_URL;
}

// Resolve the public base URL with graceful fallbacks (Railway best practice):
//   1. BETTER_AUTH_URL — explicit override, for custom domains / pinning.
//   2. RAILWAY_PUBLIC_DOMAIN — read at runtime (not as a frozen derived var), so
//      we get Railway's live domain as a stable absolute URL when present.
//   3. undefined in production — let better-auth infer per-request (same-origin).
//   4. localhost in dev.
const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
const railwayURL = railwayDomain ? `https://${railwayDomain}` : undefined;
const baseURL = isValidHttpUrl(process.env.BETTER_AUTH_URL)
  ? process.env.BETTER_AUTH_URL
  : isValidHttpUrl(railwayURL)
    ? railwayURL
    : process.env.NODE_ENV === "production"
      ? undefined
      : "http://localhost:3000";

// Derive a request's public origin, honoring the reverse proxy's forwarded
// headers. Railway terminates TLS at the edge and forwards to the container over
// HTTP, so `request.url` is `http://…` while the browser's Origin is `https://…`.
// Using X-Forwarded-Proto/Host yields the real public origin so the CSRF origin
// check matches (otherwise login fails with INVALID_ORIGIN).
function requestPublicOrigin(request?: Request): string | undefined {
  if (!request) return undefined;
  try {
    const url = new URL(request.url);
    const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim()
      || url.protocol.replace(":", "");
    const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim()
      || request.headers.get("host")
      || url.host;
    return host ? `${proto}://${host}` : undefined;
  } catch {
    return undefined;
  }
}

// Trust an explicitly-configured WEB_ORIGIN when valid (e.g. cross-origin dev, or
// a custom domain); otherwise trust the request's own (proxy-aware) public origin.
// We check the RAW env var — not a localhost-defaulted value — so an unset
// WEB_ORIGIN falls through to request-origin trust in BOTH dev (same-origin via
// the Vite proxy) and production (the Railway domain), instead of wrongly trusting
// only localhost. Trusting the request origin only ever matches same-origin
// requests (a cross-site request's Origin header differs from the server's host),
// so it's safe. better-auth may invoke this with no request during init, so guard.
const trustedOrigins = isValidHttpUrl(process.env.WEB_ORIGIN)
  ? [process.env.WEB_ORIGIN]
  : (request?: Request) => {
      const origin = requestPublicOrigin(request);
      return origin ? [origin] : [];
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
