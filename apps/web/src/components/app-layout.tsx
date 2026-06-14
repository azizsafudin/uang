import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

// One consistent column width + chrome for every signed-in page.
export function AppShell({
  actions,
  children,
}: {
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border/70">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between px-5 md:px-6">
          <Link
            to="/"
            className="font-heading text-xl leading-none tracking-tight text-foreground"
          >
            uang<span className="text-gold">.</span>
          </Link>
          <div className="flex items-center gap-1.5">{actions}</div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl px-5 py-8 md:px-6 md:py-10">
        {children}
      </main>
    </div>
  );
}

// The signature device: a short brass ledger-rule before an uppercase eyebrow.
export function Eyebrow({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <span className="h-px w-5 shrink-0 bg-gold/70" />
      <span className="text-[0.7rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {children}
      </span>
    </div>
  );
}
