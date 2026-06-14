import {
  createRouter,
  createRoute,
  createRootRoute,
  redirect,
  Outlet,
} from "@tanstack/react-router";
import { api } from "./lib/api";
import { requireInitializedAndAuthed } from "./lib/guards";
import { OnboardingPage } from "./routes/onboarding";
import { LoginPage } from "./routes/login";
import { DashboardPage } from "./routes/dashboard";
import { AccountDetailPage } from "./routes/account-detail";
import { SettingsPage } from "./routes/settings";
import { ProjectionsPage } from "./routes/projections";

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
  beforeLoad: requireInitializedAndAuthed,
});

const accountDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/accounts/$id",
  component: AccountDetailPage,
  beforeLoad: requireInitializedAndAuthed,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
  beforeLoad: requireInitializedAndAuthed,
});

const projectionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projections",
  component: ProjectionsPage,
  beforeLoad: requireInitializedAndAuthed,
});

const routeTree = rootRoute.addChildren([
  onboardingRoute,
  loginRoute,
  dashboardRoute,
  accountDetailRoute,
  settingsRoute,
  projectionsRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
