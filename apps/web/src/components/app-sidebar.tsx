import { Link, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Settings } from "lucide-react";
import { useSession } from "@/lib/auth";
import { api } from "@/lib/api";
import {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { NavMain } from "@/components/nav-main";
import { NavUser } from "@/components/nav-user";
import { ThemeToggle } from "@/components/theme-toggle";
import { ValuePrivacyToggle } from "@/components/value-privacy-toggle";
import { useIsPWA } from "@/hooks/use-pwa";
import { useIsMobile } from "@/hooks/use-mobile";

function HouseholdSwitcher() {
  const { data: household } = useQuery({
    queryKey: ["household"],
    queryFn: async () => (await api.onboarding.household.get()).data,
  });
  const name = household?.householdName ?? "uang.";
  const subtitle = household?.baseCurrency ? `Base · ${household.baseCurrency}` : "Household";

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          size="lg"
          className="cursor-default hover:bg-transparent active:bg-transparent"
        >
          <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary font-heading text-base leading-none text-primary-foreground">
            u<span className="text-gold">.</span>
          </div>
          <div className="grid flex-1 text-left leading-tight">
            <span className="truncate font-heading text-base tracking-tight">{name}</span>
            <span className="truncate text-xs text-muted-foreground">{subtitle}</span>
          </div>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function NavSettings() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { isMobile, setOpenMobile } = useSidebar();

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          render={<Link to="/settings" />}
          isActive={pathname.startsWith("/settings")}
          tooltip="Settings"
          onClick={() => {
            if (isMobile) setOpenMobile(false);
          }}
        >
          <Settings />
          <span>Settings</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

export function AppSidebar() {
  const { data: session } = useSession();
  const user = {
    name: session?.user?.name ?? "Account",
    email: session?.user?.email ?? "",
    avatar: session?.user?.image ?? undefined,
  };
  const isPwaMobile = useIsPWA() && useIsMobile();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <HouseholdSwitcher />
      </SidebarHeader>

      <SidebarContent>
        <NavMain />
      </SidebarContent>

      <SidebarFooter>
        {isPwaMobile ? (
          <div className="flex items-center justify-end gap-1 px-1 pb-1">
            <ValuePrivacyToggle />
            <ThemeToggle />
          </div>
        ) : null}
        <NavSettings />
        <NavUser user={user} />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
