import { useSession } from "@/lib/auth";
import { Money } from "@/components/money.tsx";
import { OdometerMoney } from "@/components/odometer-money";
import { cn } from "@/lib/utils";

function greeting(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function todayLabel(): string {
  return new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

export function DashboardHero({
  totalBaseMinor,
  baseCurrency,
  changeMinor,
  changePct,
  holdings,
  tiles,
  actions,
}: {
  totalBaseMinor: number | null;
  baseCurrency: string;
  changeMinor: number | null;
  changePct: number | null;
  holdings?: React.ReactNode; // optional portfolio breakdown panel
  tiles?: React.ReactNode; // optional companion tiles, rendered beside the holdings panel
  actions?: React.ReactNode; // top-right controls (e.g. tile edit toggle)
}) {
  const { data: session } = useSession();
  const name = session?.user?.name ?? "there";
  const now = new Date();
  const up = changeMinor !== null && changeMinor >= 0;

  return (
    <section
      data-testid="dashboard-hero"
      className="relative overflow-hidden rounded-[18px] border border-border px-6 py-7 shadow-sm md:px-8 md:py-7"
      style={{
        backgroundImage:
          "radial-gradient(120% 140% at 85% -10%, color-mix(in oklab, var(--gold) 18%, transparent), transparent 55%)," +
          "radial-gradient(90% 120% at 0% 110%, color-mix(in oklab, var(--primary) 10%, transparent), transparent 50%)," +
          "linear-gradient(var(--card), var(--background))",
      }}
    >
      {/* polished gold top rule */}
      <div
        className="absolute inset-x-0 top-0 h-[3px]"
        style={{
          background:
            "linear-gradient(90deg, transparent, color-mix(in oklab, var(--gold) 55%, transparent), var(--gold), color-mix(in oklab, var(--gold) 55%, transparent), transparent)",
        }}
      />
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-heading text-[1.8rem] font-medium tracking-tight">
            {greeting(now.getHours())}, <span className="italic text-gold">{name}</span>.
          </div>
          <div className="mt-1.5 font-heading text-[1.05rem] italic tracking-tight text-muted-foreground">
            {todayLabel()}
          </div>
        </div>
        {actions && <div className="relative shrink-0">{actions}</div>}
      </div>

      {/* grand, centered net-worth headline */}
      <div className="mt-7 flex flex-col items-center text-center">
        <p
          data-testid="networth-hero"
          className="mt-3 font-heading text-[3.25rem] font-medium leading-none tracking-tight tabular-nums md:text-[4.25rem]"
        >
          {totalBaseMinor === null ? (
            "—"
          ) : (
            <OdometerMoney minor={totalBaseMinor} currency={baseCurrency} />
          )}
        </p>
        {changeMinor !== null && (
          <span
            className={cn(
              "mt-4 inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium",
              up ? "bg-primary/10 text-primary" : "bg-destructive/10 text-destructive",
            )}
          >
            <span aria-hidden>{up ? "▲" : "▼"}</span>
            <Money minor={Math.abs(changeMinor)} currency={baseCurrency} />
            {changePct !== null ? ` (${Math.abs(changePct).toFixed(1)}%)` : ""}
            <span className="font-normal text-muted-foreground">this period</span>
          </span>
        )}
      </div>

      {(holdings || tiles) && (
        <div className={cn("mt-7 grid items-stretch gap-4", holdings && tiles && "md:grid-cols-2")}>
          {holdings}
          {tiles}
        </div>
      )}
    </section>
  );
}
