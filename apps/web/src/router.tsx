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
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppSidebar } from "@/components/app-sidebar";

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const appLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app-shell",
  beforeLoad: requireInitializedAndAuthed,
  component: () => (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <SidebarTrigger className="fixed left-3 top-3 z-20 md:hidden" />
          <Outlet />
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  ),
});

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
  getParentRoute: () => appLayoutRoute,
  path: "/",
  component: DashboardPage,
});

const accountDetailRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/accounts/$id",
  component: AccountDetailPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/settings",
  component: SettingsPage,
});

const projectionsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/projections",
  component: ProjectionsPage,
});

const goalsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/goals",
  component: GoalsPage,
});

const goalDetailRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/goals/$id",
  component: GoalDetailPage,
});

const routeTree = rootRoute.addChildren([
  onboardingRoute,
  loginRoute,
  appLayoutRoute.addChildren([
    dashboardRoute,
    accountDetailRoute,
    settingsRoute,
    projectionsRoute,
    goalsRoute,
    goalDetailRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
