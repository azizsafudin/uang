import { Link, useRouterState } from "@tanstack/react-router";
import { LayoutDashboard, Target, TrendingUp, CandlestickChart } from "lucide-react";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/instruments", label: "Instruments", icon: CandlestickChart },
  { to: "/goals", label: "Goals", icon: Target },
  { to: "/projections", label: "Projections", icon: TrendingUp },
] as const;

export function NavMain() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { isMobile, setOpenMobile } = useSidebar();

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Overview</SidebarGroupLabel>
      <SidebarMenu>
        {NAV.map(({ to, label, icon: Icon }) => (
          <SidebarMenuItem key={to}>
            <SidebarMenuButton
              render={<Link to={to} />}
              isActive={to === "/" ? pathname === "/" : pathname.startsWith(to)}
              tooltip={label}
              onClick={() => {
                // Dismiss the mobile nav sheet after navigating.
                if (isMobile) setOpenMobile(false);
              }}
            >
              <Icon />
              <span>{label}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}
