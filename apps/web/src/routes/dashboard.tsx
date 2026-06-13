import { useNavigate } from "@tanstack/react-router";
import { useSession, signOut } from "@/lib/auth";
import { Button } from "@/components/ui/button";

export function DashboardPage() {
  const nav = useNavigate();
  const { data } = useSession();
  return (
    <div className="min-h-screen p-8 space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Uang</h1>
        <Button variant="outline" onClick={async () => { await signOut(); await nav({ to: "/login" }); }}>
          Sign out
        </Button>
      </header>
      <p className="text-muted-foreground">Signed in as {data?.user?.email}. Accounts &amp; net worth arrive in Plan 2.</p>
    </div>
  );
}
