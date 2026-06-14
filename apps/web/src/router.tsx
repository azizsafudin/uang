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
import { GoalsPage } from "./routes/goals";
import { GoalDetailPage } from "./routes/goal-detail";

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/onboarding",
  component: OnboardingPage,
  beforeLoad: async () => {
    // Already set up? Onboarding is a dead end — send them to sign in.
    const { data } = await api.onboarding.status.get();
    if (data?.initialized) throw redirect({ to: "/login" });
  },
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

const goalsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/goals",
  component: GoalsPage,
  beforeLoad: requireInitializedAndAuthed,
});

const goalDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/goals/$id",
  component: GoalDetailPage,
  beforeLoad: requireInitializedAndAuthed,
});

const routeTree = rootRoute.addChildren([
  onboardingRoute,
  loginRoute,
  dashboardRoute,
  accountDetailRoute,
  settingsRoute,
  projectionsRoute,
  goalsRoute,
  goalDetailRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
