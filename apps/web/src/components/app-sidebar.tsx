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
  SidebarTrigger,
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
        <div className="flex items-center justify-between gap-2 px-2 py-1.5">
          <Link
            to="/"
            className="font-heading text-xl leading-none tracking-tight text-foreground group-data-[collapsible=icon]:hidden"
          >
            uang<span className="text-gold">.</span>
          </Link>
          <SidebarTrigger className="-mr-1" />
        </div>
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
    </Sidebar>
  );
}
