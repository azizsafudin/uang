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
import { PlanPage } from "./routes/plan";
import { GoalDetailPage } from "./routes/goal-detail";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppSidebar } from "@/components/app-sidebar";
import { ValuesHiddenProvider } from "@/lib/values-hidden";
import { AppTopBar } from "@/components/app-top-bar";
import { PwaTabBar } from "@/components/pwa-tab-bar";
import { useIsPWA } from "@/hooks/use-pwa";
import { useIsMobile } from "@/hooks/use-mobile";

const rootRoute = createRootRoute({ component: () => <Outlet /> });

function AppLayout() {
  // PWA-mobile = installed standalone AND phone-width. Reuse both hooks inline
  // (no combined hook). In this mode the top bar is replaced by a bottom tab bar.
  const isPwaMobile = useIsPWA() && useIsMobile();
  return (
    <ValuesHiddenProvider>
      <TooltipProvider>
        <SidebarProvider>
          <AppSidebar />
          <SidebarInset>
            {isPwaMobile ? null : <AppTopBar />}
            {isPwaMobile ? (
              <div className="pb-[calc(4rem+env(safe-area-inset-bottom))]">
                <Outlet />
              </div>
            ) : (
              <Outlet />
            )}
            {isPwaMobile ? <PwaTabBar /> : null}
          </SidebarInset>
        </SidebarProvider>
      </TooltipProvider>
    </ValuesHiddenProvider>
  );
}

// Pathless layout route: renders the sidebar shell once around every
// authenticated route. Its id ("app") prefixes child route ids — hence
// useParams reads from "/app/accounts/$id".
const appLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  beforeLoad: requireInitializedAndAuthed,
  component: AppLayout,
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

// Assets tab state in the URL. Holdings is the default and is omitted; only the
// non-default "accounts" tab is persisted, so a clean /assets stays clean.
export type AssetsSearch = { tab?: "accounts" | "holdings" };

function validateAssetsSearch(search: Record<string, unknown>): AssetsSearch {
  return { tab: search.tab === "accounts" ? "accounts" : undefined };
}

const assetsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/assets",
  validateSearch: validateAssetsSearch,
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

// Transactions list state (search + filters + page) lives in the URL as the
// source of truth. All fields optional; defaults (empty/all/page 1) are omitted
// from the URL so a clean /transactions stays clean.
export type TransactionsSearch = {
  q?: string;
  kind?: string;
  account?: string;
  owner?: string;
  page?: number;
};

function validateTransactionsSearch(search: Record<string, unknown>): TransactionsSearch {
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
  const pageNum = Number(search.page);
  return {
    q: str(search.q),
    kind: str(search.kind),
    account: str(search.account),
    owner: str(search.owner),
    // page is 1-based in the URL; only persist when past the first page.
    page: Number.isInteger(pageNum) && pageNum > 1 ? pageNum : undefined,
  };
}

const transactionsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/transactions",
  validateSearch: validateTransactionsSearch,
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

const planRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/plan",
  component: PlanPage,
});

const goalsRedirect = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/goals",
  beforeLoad: () => { throw redirect({ to: "/plan" }); },
});

const projectionsRedirect = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/projections",
  beforeLoad: () => { throw redirect({ to: "/plan" }); },
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
    planRoute,
    goalsRedirect,
    projectionsRedirect,
    goalDetailRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
