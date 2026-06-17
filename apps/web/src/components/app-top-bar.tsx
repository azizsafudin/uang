import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { AppBreadcrumb } from "@/components/app-breadcrumb";
import { ThemeToggle } from "@/components/theme-toggle";
import { ValuePrivacyToggle } from "@/components/value-privacy-toggle";

// The sticky top header for browser / desktop-PWA layout: sidebar trigger,
// breadcrumb, and the value-privacy + theme toggles. Hidden in PWA-mobile mode,
// where the toggles move to the sidebar footer.
export function AppTopBar() {
  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b border-border/70 bg-background/95 px-4 backdrop-blur">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 h-4" />
      <AppBreadcrumb />
      <div className="ml-auto flex items-center gap-1">
        <ValuePrivacyToggle />
        <ThemeToggle />
      </div>
    </header>
  );
}
