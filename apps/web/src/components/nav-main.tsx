import { Link, useRouterState } from "@tanstack/react-router";
import { LayoutDashboard, Target, TrendingUp } from "lucide-react";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/goals", label: "Goals", icon: Target },
  { to: "/projections", label: "Projections", icon: TrendingUp },
] as const;

export function NavMain() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

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
