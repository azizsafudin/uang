import { createAuthClient } from "better-auth/react";

// Same-origin in production; VITE_API_URL points at the cross-origin API in dev.
const base = import.meta.env.VITE_API_URL || window.location.origin;
export const authClient = createAuthClient({ baseURL: `${base}/api/auth` });
export const { useSession, signIn, signOut } = authClient;
