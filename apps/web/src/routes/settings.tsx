import { useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SCALE } from "@uang/shared";
import { api } from "@/lib/api";
import { fxCollection, newId } from "@/lib/collections";
import { AppShell, Section } from "@/components/app-layout";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { CurrencySelect } from "@/components/currency-select";
import { useSession } from "@/lib/auth";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// The API is mounted under `/api` (same base the eden client uses): same-origin
// in production, or VITE_API_URL for the cross-origin dev API. These plain links
// (binary .db / .zip downloads and the multipart import upload) bypass eden, so
// build the `/api`-prefixed URL the same way here.
const API_URL = `${import.meta.env.VITE_API_URL || window.location.origin}/api`;

type User = { id: string; email: string; name: string; isAdmin: boolean };

function RestoreSection() {
  const { data: session } = useSession();
  const meId = session?.user?.id;
  const usersQ = useQuery({
    queryKey: ["users"],
    queryFn: async (): Promise<User[]> => {
      const { data, error } = await api.users.get();
      if (error) throw new Error(String(error));
      return (data as unknown as User[]) ?? [];
    },
  });
  const isAdmin =
    usersQ.data?.some((u) => u.id === meId && u.isAdmin) ?? false;

  const [backedUp, setBackedUp] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isAdmin) return null;

  async function doImport() {
    if (!file) return;
    setImporting(true);
    setError(null);
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`${API_URL}/import`, {
      method: "POST",
      body: fd,
      credentials: "include",
    });
    if (res.ok) {
      window.location.href = "/login";
      return;
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    setError(body.error ?? "Import failed");
    setImporting(false);
    setConfirmOpen(false);
  }

  return (
    <Section
      eyebrow="Restore"
      title="Restore from a backup"
      description="Replace ALL data with the contents of a uang .db file. This signs everyone out. Download a backup of your current data first."
    >
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <span className="flex size-6 items-center justify-center rounded-full border border-border text-xs">
            1
          </span>
          <a
            href={`${API_URL}/export`}
            download
            onClick={() => setBackedUp(true)}
          >
            <Button variant="outline">Download current backup (.db)</Button>
          </a>
        </div>

        <div className="flex items-center gap-3">
          <span className="flex size-6 items-center justify-center rounded-full border border-border text-xs">
            2
          </span>
          <Input
            type="file"
            accept=".db"
            disabled={!backedUp}
            className="w-auto"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setFile(f);
              setError(null);
              if (f) setConfirmOpen(true);
            }}
          />
          {!backedUp && (
            <span className="text-sm text-muted-foreground">
              Download a backup first
            </span>
          )}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Replace all data?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This permanently replaces every account, transaction, goal, and
            member with the contents of{" "}
            <span className="font-medium">{file?.name}</span>, and signs everyone
            out. This cannot be undone from the app.
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              disabled={importing}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={doImport}
              disabled={importing || !file}
            >
              {importing ? "Restoring…" : "Replace all data"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Section>
  );
}

export function SettingsPage() {
  const qc = useQueryClient();
  const { data: fxRates } = useLiveQuery(fxCollection);

  const usersQ = useQuery({
    queryKey: ["users"],
    queryFn: async (): Promise<User[]> => {
      const { data, error } = await api.users.get();
      if (error) throw new Error(String(error));
      return (data as unknown as User[]) ?? [];
    },
  });

  const [fx, setFx] = useState({
    currency: "",
    date: new Date().toISOString().slice(0, 10),
    rate: "",
  });
  const [invite, setInvite] = useState({ email: "", name: "", password: "" });

  async function addFx(e: React.FormEvent) {
    e.preventDefault();
    const rate = parseFloat(fx.rate);
    if (Number.isNaN(rate)) return;
    await fxCollection.insert({
      id: newId(),
      currency: fx.currency.toUpperCase(),
      date: fx.date,
      rateScaled: Math.round(rate * Number(SCALE)),
      createdAt: Math.floor(Date.now() / 1000),
    });
    setFx((prev) => ({ ...prev, currency: "", rate: "" }));
  }

  async function addUser(e: React.FormEvent) {
    e.preventDefault();
    await api.users.post(invite);
    await qc.invalidateQueries({ queryKey: ["users"] });
    setInvite({ email: "", name: "", password: "" });
  }

  return (
    <AppShell>
      <PageHeader title="Settings" />

      <div className="space-y-5">
        <Section
          eyebrow="Currencies"
          title="Exchange rates"
          description="Set the value of one unit of each foreign currency in your base currency. The latest rate on or before a date is used."
        >
          <form
            onSubmit={addFx}
            className="grid grid-cols-2 items-end gap-4 sm:grid-cols-4"
          >
            <Field label="Currency">
              <CurrencySelect
                data-testid="fx-currency"
                value={fx.currency}
                placeholder="Select"
                onValueChange={(code) => setFx((p) => ({ ...p, currency: code }))}
              />
            </Field>
            <Field label="Date">
              <Input
                data-testid="fx-date"
                type="date"
                value={fx.date}
                onChange={(e) => setFx((p) => ({ ...p, date: e.target.value }))}
                required
              />
            </Field>
            <Field label="Rate">
              <Input
                data-testid="fx-rate"
                type="number"
                step="any"
                placeholder="0.22"
                value={fx.rate}
                onChange={(e) => setFx((p) => ({ ...p, rate: e.target.value }))}
                required
              />
            </Field>
            <Button type="submit">Add rate</Button>
          </form>

          {(fxRates ?? []).length > 0 && (
            <div className="mt-4 overflow-hidden rounded-lg border border-border">
              {(fxRates ?? []).map((r, i) => (
                <div
                  key={r.id}
                  className={`flex items-center justify-between px-3 py-2 text-sm ${i > 0 ? "border-t border-border/70" : ""}`}
                >
                  <span className="font-medium">
                    {r.currency}{" "}
                    <span className="text-muted-foreground">@ {r.date}</span>
                  </span>
                  <span className="flex items-center gap-2 tabular-nums">
                    {r.rateScaled / Number(SCALE)}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => fxCollection.delete(r.id)}
                    >
                      ✕
                    </Button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section
          eyebrow="Access"
          title="Household members"
          description="Everyone you add shares all accounts and data, and can sign in with their own credentials."
        >
          <form
            onSubmit={addUser}
            className="grid grid-cols-2 items-end gap-4 sm:grid-cols-4"
          >
            <Field label="Name">
              <Input
                data-testid="invite-name"
                value={invite.name}
                onChange={(e) =>
                  setInvite((p) => ({ ...p, name: e.target.value }))
                }
                required
              />
            </Field>
            <Field label="Email">
              <Input
                data-testid="invite-email"
                type="email"
                value={invite.email}
                onChange={(e) =>
                  setInvite((p) => ({ ...p, email: e.target.value }))
                }
                required
              />
            </Field>
            <Field label="Password">
              <Input
                data-testid="invite-password"
                type="password"
                value={invite.password}
                onChange={(e) =>
                  setInvite((p) => ({ ...p, password: e.target.value }))
                }
                minLength={8}
                required
              />
            </Field>
            <Button type="submit">Invite</Button>
          </form>

          <div className="mt-4 overflow-hidden rounded-lg border border-border">
            {(usersQ.data ?? []).map((u, i) => (
              <div
                key={u.id}
                className={`flex items-center justify-between px-3 py-2 text-sm ${i > 0 ? "border-t border-border/70" : ""}`}
              >
                <span>
                  <span className="font-medium">{u.name}</span>{" "}
                  <span className="text-muted-foreground">{u.email}</span>
                </span>
                <span className="text-xs uppercase tracking-wide text-muted-foreground">
                  {u.isAdmin ? "Admin" : "Member"}
                </span>
              </div>
            ))}
          </div>
        </Section>

        <Section
          eyebrow="Backup"
          title="Export your data"
          description="Download the full database as a SQLite file, or a zip of readable CSVs."
        >
          <div className="flex flex-wrap gap-3">
            <a href={`${API_URL}/export`}>
              <Button variant="outline">Export database (.db)</Button>
            </a>
            <a href={`${API_URL}/export/csv`}>
              <Button variant="outline">Export as CSV (.zip)</Button>
            </a>
          </div>
        </Section>

        <RestoreSection />
      </div>
    </AppShell>
  );
}
