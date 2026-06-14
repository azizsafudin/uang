import { Link, useRouterState, useNavigate } from "@tanstack/react-router";
import { LayoutDashboard, TrendingUp, Settings, LogOut } from "lucide-react";
import { signOut } from "@/lib/auth";
import {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarGroup,
  SidebarRail,
} from "@/components/ui/sidebar";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/projections", label: "Projections", icon: TrendingUp },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

export function AppSidebar() {
  const nav = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link to="/" />}>
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary font-heading text-base leading-none text-primary-foreground">
                u<span className="text-gold">.</span>
              </div>
              <span className="font-heading text-xl leading-none tracking-tight">
                uang<span className="text-gold">.</span>
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
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
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Sign out"
              onClick={async () => {
                await signOut();
                await nav({ to: "/login" });
              }}
            >
              <LogOut />
              <span>Sign out</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
