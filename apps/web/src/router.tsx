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
import { AssetsPage } from "./routes/assets";
import { AccountDetailPage } from "./routes/account-detail";
import { InstrumentsPage } from "./routes/instruments";
import { TransactionsPage } from "./routes/transactions";
import { InstrumentDetailPage } from "./routes/instrument-detail";
import { SettingsPage } from "./routes/settings";
import { ProjectionsPage } from "./routes/projections";
import { GoalsPage } from "./routes/goals";
import { GoalDetailPage } from "./routes/goal-detail";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import { AppSidebar } from "@/components/app-sidebar";
import { AppBreadcrumb } from "@/components/app-breadcrumb";
import { ThemeToggle } from "@/components/theme-toggle";
import { ValuesHiddenProvider } from "@/lib/values-hidden";
import { ValuePrivacyToggle } from "@/components/value-privacy-toggle";

const rootRoute = createRootRoute({ component: () => <Outlet /> });

// Pathless layout route: renders the sidebar shell once around every
// authenticated route. Its id ("app") prefixes child route ids — hence
// useParams reads from "/app/accounts/$id".
const appLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  beforeLoad: requireInitializedAndAuthed,
  component: () => (
    <ValuesHiddenProvider>
      <TooltipProvider>
        <SidebarProvider>
          <AppSidebar />
          <SidebarInset>
            <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b border-border/70 bg-background/95 px-4 backdrop-blur">
              <SidebarTrigger className="-ml-1" />
              <Separator orientation="vertical" className="mr-1 h-4" />
              <AppBreadcrumb />
              <div className="ml-auto flex items-center gap-1">
                <ValuePrivacyToggle />
                <ThemeToggle />
              </div>
            </header>
            <Outlet />
          </SidebarInset>
        </SidebarProvider>
      </TooltipProvider>
    </ValuesHiddenProvider>
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

const assetsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/assets",
  component: AssetsPage,
});

const accountDetailRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/accounts/$id",
  component: AccountDetailPage,
});

const instrumentsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/instruments",
  component: InstrumentsPage,
});

const transactionsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/transactions",
  component: TransactionsPage,
});

const instrumentDetailRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/instruments/$id",
  component: InstrumentDetailPage,
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
    assetsRoute,
    accountDetailRoute,
    instrumentsRoute,
    transactionsRoute,
    instrumentDetailRoute,
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
