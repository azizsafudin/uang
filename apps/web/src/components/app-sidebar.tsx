import { Link } from "@tanstack/react-router";
import { useSession } from "@/lib/auth";
import {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarRail,
} from "@/components/ui/sidebar";
import { NavMain } from "@/components/nav-main";
import { NavUser } from "@/components/nav-user";

export function AppSidebar() {
  const { data: session } = useSession();
  const user = {
    name: session?.user?.name ?? "Account",
    email: session?.user?.email ?? "",
    avatar: session?.user?.image ?? undefined,
  };

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
        <NavMain />
      </SidebarContent>

      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
