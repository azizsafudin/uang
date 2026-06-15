import { useSession } from "@/lib/auth";
import { Eyebrow } from "@/components/app-layout";
import { Money } from "@/components/money.tsx";
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
  owner,
  totalBaseMinor,
  baseCurrency,
  series,
  changeMinor,
  changePct,
  tiles,
  actions,
}: {
  owner: string;
  totalBaseMinor: number | null;
  baseCurrency: string;
  series: { date: string; totalBaseMinor: number }[];
  changeMinor: number | null;
  changePct: number | null;
  tiles: React.ReactNode; // companion tiles, rendered beside the vault
  actions?: React.ReactNode; // top-right controls (e.g. tile edit toggle)
}) {
  const { data: session } = useSession();
  const name = session?.user?.name ?? "there";
  const now = new Date();

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
          <div className="mt-1 text-sm text-muted-foreground">{todayLabel()}</div>
        </div>
        {actions && <div className="relative shrink-0">{actions}</div>}
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-[1.45fr_1fr]">
        {/* pine-green vault */}
        <div
          className="relative overflow-hidden rounded-[14px] px-6 py-5 text-[#f6efdf]"
          style={{
            backgroundImage:
              "radial-gradient(130% 130% at 92% -20%, #2a7361, var(--primary) 45%, #17463a)",
          }}
        >
          <Eyebrow className="[&_span:last-child]:text-[rgba(245,239,231,0.7)] [&_span:first-child]:bg-gold/80">
            Net worth · {owner === "household" ? "household" : "personal"}
          </Eyebrow>
          <p
            data-testid="networth-hero"
            className={cn(
              "mt-2 font-heading text-[2.75rem] font-medium leading-none tabular-nums text-[#f6efdf]",
            )}
          >
            {totalBaseMinor === null ? "—" : <Money minor={totalBaseMinor} currency={baseCurrency} />}
          </p>
          <HeroSparkline points={series} />
          {changeMinor !== null && (
            <div className="relative mt-3">
              <span className="rounded-full bg-gold/20 px-3 py-1 text-xs font-medium text-[#dff0e4]">
                {changeMinor >= 0 ? "▲" : "▼"}{" "}
                <Money minor={Math.abs(changeMinor)} currency={baseCurrency} />
                {changePct !== null ? ` (${Math.abs(changePct).toFixed(1)}%)` : ""} this period
              </span>
            </div>
          )}
        </div>

        {/* companion tiles */}
        {tiles}
      </div>
    </section>
  );
}

function HeroSparkline({ points }: { points: { totalBaseMinor: number }[] }) {
  if (points.length < 2) return <div className="mt-2 h-10" />;
  const values = points.map((p) => p.totalBaseMinor);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = 360 / (values.length - 1);
  const coords = values.map((v, i) => `${(i * stepX).toFixed(1)},${(36 - ((v - min) / span) * 32).toFixed(1)}`);
  return (
    <svg
      width="100%"
      height="40"
      viewBox="0 0 360 40"
      preserveAspectRatio="none"
      className="relative mt-2"
      aria-hidden
    >
      <polyline points={coords.join(" ")} stroke="var(--gold)" strokeWidth={2} fill="none" />
      <polyline points={`${coords.join(" ")} 360,40 0,40`} fill="color-mix(in oklab, var(--gold) 12%, transparent)" stroke="none" />
    </svg>
  );
}
