import { createRouter, createRoute, createRootRoute, redirect } from "@tanstack/react-router";
import { Outlet } from "@tanstack/react-router";
import { api } from "./lib/api";
import { authClient } from "./lib/auth";
import { OnboardingPage } from "./routes/onboarding";
import { LoginPage } from "./routes/login";
import { DashboardPage } from "./routes/dashboard";

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/onboarding",
  component: OnboardingPage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
  beforeLoad: async () => {
    const { data } = await api.onboarding.status.get();
    if (!data?.initialized) throw redirect({ to: "/onboarding" });
  },
});

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: DashboardPage,
  beforeLoad: async () => {
    const { data } = await api.onboarding.status.get();
    if (!data?.initialized) throw redirect({ to: "/onboarding" });
    const session = await authClient.getSession();
    if (!session.data) throw redirect({ to: "/login" });
  },
});

const routeTree = rootRoute.addChildren([onboardingRoute, loginRoute, dashboardRoute]);
export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register { router: typeof router; }
}
