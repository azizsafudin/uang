import { Elysia } from "elysia";
import { auth } from "../auth";

// Resolves the better-auth session and exposes userId/isAdmin to handlers.
// Returns 401 for requests without a valid session.
// .as("scoped") propagates resolve/onBeforeHandle to the parent app that
// does .use(authGuard), so the parent's route handlers receive userId/isAdmin.
export const authGuard = new Elysia({ name: "auth-guard" })
  .resolve(async ({ request }) => {
    const session = await auth.api.getSession({ headers: request.headers });
    return { userId: session?.user?.id ?? null, isAdmin: !!session?.user?.isAdmin };
  })
  .onBeforeHandle(({ userId, set }: any) => {
    if (!userId) {
      set.status = 401;
      return { error: "unauthorized" };
    }
  })
  .as("scoped");
