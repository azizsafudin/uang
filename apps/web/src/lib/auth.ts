import { createAuthClient } from "better-auth/react";

const url = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
export const authClient = createAuthClient({ baseURL: `${url}/api/auth` });
export const { useSession, signIn, signOut } = authClient;
