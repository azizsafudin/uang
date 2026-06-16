import { redirect } from "@tanstack/react-router";
import { api } from "./api";
import { authClient } from "./auth";
import { queryClient } from "./query";

type AuthGate = { initialized: boolean; authed: boolean };

const AUTH_GATE_KEY = ["auth-gate"] as const;

// One network probe for both the onboarding status and the session, run in
// parallel. Cached below so navigation between authed pages doesn't re-hit the
// network on every transition.
async function loadAuthGate(): Promise<AuthGate> {
  const [status, session] = await Promise.all([
    api.onboarding.status.get(),
    authClient.getSession(),
  ]);
  return { initialized: !!status.data?.initialized, authed: !!session.data };
}

// Shared beforeLoad: require an initialized household + an authenticated session.
//
// This runs on *every* navigation into the authed layout. The actual security
// boundary is server-side (auth-guard.ts checks the session on each API call),
// so this is only a UX redirect guard — safe to serve from cache. We cache the
// probe so transitions between pages are instant instead of waiting on two
// sequential network round trips each time. invalidateAuthGate() forces a fresh
// probe after sign-in / sign-out.
export async function requireInitializedAndAuthed() {
  const { initialized, authed } = await queryClient.ensureQueryData({
    queryKey: AUTH_GATE_KEY,
    queryFn: loadAuthGate,
    staleTime: 5 * 60_000,
  });
  if (!initialized) throw redirect({ to: "/onboarding" });
  if (!authed) throw redirect({ to: "/login" });
}

// Drop the cached gate so the next navigation re-probes (call after the session
// changes — sign-in or sign-out).
export function invalidateAuthGate() {
  return queryClient.invalidateQueries({ queryKey: AUTH_GATE_KEY });
}
