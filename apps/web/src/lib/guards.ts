import { redirect } from "@tanstack/react-router";
import { api } from "./api";
import { authClient } from "./auth";

// Shared beforeLoad: require an initialized household + an authenticated session.
export async function requireInitializedAndAuthed() {
  const { data } = await api.onboarding.status.get();
  if (!data?.initialized) throw redirect({ to: "/onboarding" });
  const session = await authClient.getSession();
  if (!session.data) throw redirect({ to: "/login" });
}
