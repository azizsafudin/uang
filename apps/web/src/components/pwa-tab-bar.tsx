import { useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { Home, ArrowLeftRight, Plus, Wallet, Menu, type LucideIcon } from "lucide-react";
import { useSidebar } from "@/components/ui/sidebar";
import { AddTransactionDialog } from "@/components/add-transaction-dialog";
import { cn } from "@/lib/utils";

type TabTo = "/" | "/transactions" | "/assets";

function TabLink({ to, icon: Icon, label, active }: { to: TabTo; icon: LucideIcon; label: string; active: boolean }) {
  return (
    <Link
      to={to}
      aria-label={label}
      className={cn(
        "flex flex-1 flex-col items-center justify-center gap-0.5 text-[0.65rem] font-medium",
        active ? "text-primary" : "text-muted-foreground",
      )}
    >
      <Icon className="size-5" />
      <span>{label}</span>
    </Link>
  );
}

function TabButton({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex flex-1 flex-col items-center justify-center gap-0.5 text-[0.65rem] font-medium text-muted-foreground"
    >
      <Icon className="size-5" />
      <span>{label}</span>
    </button>
  );
}

// Bottom tab bar shown only in PWA-mobile mode (gated by the layout route).
export function PwaTabBar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { setOpenMobile } = useSidebar();
  const [addOpen, setAddOpen] = useState(false);

  return (
    <>
      <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-background/95 backdrop-blur pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto flex h-16 max-w-5xl items-stretch justify-around">
          <TabLink to="/" icon={Home} label="Home" active={pathname === "/"} />
          <TabLink to="/transactions" icon={ArrowLeftRight} label="Transactions" active={pathname.startsWith("/transactions")} />
          {/* Center "+" — raised accent button that opens the global add-transaction flow. */}
          <div className="flex flex-1 items-center justify-center">
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              aria-label="Add transaction"
              className="-mt-6 flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg ring-4 ring-background"
            >
              <Plus className="size-6" />
            </button>
          </div>
          <TabLink to="/assets" icon={Wallet} label="Assets" active={pathname.startsWith("/assets")} />
          <TabButton icon={Menu} label="More" onClick={() => setOpenMobile(true)} />
        </div>
      </nav>
      <AddTransactionDialog open={addOpen} onOpenChange={setAddOpen} showTrigger={false} />
    </>
  );
}
