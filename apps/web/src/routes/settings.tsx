import { useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { SCALE } from "@uang/shared";
import { api } from "@/lib/api";
import { fxCollection, membersCollection, newId } from "@/lib/collections";
import { AppShell, Eyebrow } from "@/components/app-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

type User = { id: string; email: string; name: string; isAdmin: boolean };

function Section({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border bg-card p-5 md:p-6">
      <Eyebrow className="mb-2.5">{eyebrow}</Eyebrow>
      <h2 className="font-heading text-xl tracking-tight">{title}</h2>
      {description && (
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      )}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function ProjectionAssumptionsSection() {
  const qc = useQueryClient();
  const settingsQ = useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const { data, error } = await api.settings.get();
      if (error) throw new Error(String(error));
      return data as unknown as {
        baseCurrency: string; contributionGrowthRateBps: number; projectionEndAge: number;
      };
    },
  });

  async function patch(body: { contributionGrowthRateBps?: number; projectionEndAge?: number }) {
    await api.settings.patch(body);
    await qc.invalidateQueries({ queryKey: ["settings"] });
    await qc.invalidateQueries({ queryKey: ["goals", "analysis"] });
  }

  const s = settingsQ.data;
  return (
    <Section
      eyebrow="Projections"
      title="Assumptions"
      description="The annual return used to solve required goal contributions, and how far the projection curve runs."
    >
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label>Contribution return %</Label>
          <Input
            type="number"
            step="any"
            className="w-32"
            defaultValue={s ? s.contributionGrowthRateBps / 100 : ""}
            onBlur={(e) => {
              const v = Math.round((parseFloat(e.target.value) || 0) * 100);
              if (s && v !== s.contributionGrowthRateBps) patch({ contributionGrowthRateBps: v });
            }}
          />
        </div>
        <div>
          <Label>Project until age</Label>
          <Input
            type="number"
            min={1}
            className="w-32"
            defaultValue={s?.projectionEndAge ?? ""}
            onBlur={(e) => {
              const v = Math.max(1, parseInt(e.target.value, 10) || 90);
              if (s && v !== s.projectionEndAge) patch({ projectionEndAge: v });
            }}
          />
        </div>
      </div>
    </Section>
  );
}

function MembersSection() {
  const { data: members = [] } = useLiveQuery(membersCollection);
  return (
    <Section eyebrow="Projections" title="Member birth years">
      <div className="space-y-3">
        {members.map((m) => (
          <div key={m.id} className="flex items-center justify-between gap-3">
            <Label className="flex-1">{m.name}</Label>
            <Input
              type="number"
              min={1900}
              max={new Date().getFullYear()}
              className="w-32"
              placeholder="Birth year"
              defaultValue={m.birthYear ?? ""}
              onBlur={(e) => {
                const v = e.target.value === "" ? null : parseInt(e.target.value, 10);
                if (v !== (m.birthYear ?? null)) {
                  membersCollection.update(m.id, (draft) => { draft.birthYear = v; });
                }
              }}
            />
          </div>
        ))}
      </div>
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
    <AppShell
      actions={
        <Link to="/">
          <Button variant="ghost" size="sm">
            ← Back
          </Button>
        </Link>
      }
    >
      <h1 className="mb-6 font-heading text-3xl tracking-tight">Settings</h1>

      <div className="space-y-5">
        <Section
          eyebrow="Currencies"
          title="Exchange rates"
          description="Set the value of one unit of each foreign currency in your base currency. The latest rate on or before a date is used."
        >
          <form
            onSubmit={addFx}
            className="grid grid-cols-2 items-end gap-2 sm:grid-cols-4"
          >
            <div>
              <Label>Currency</Label>
              <Input
                data-testid="fx-currency"
                value={fx.currency}
                maxLength={3}
                placeholder="MYR"
                onChange={(e) =>
                  setFx((p) => ({ ...p, currency: e.target.value }))
                }
                required
              />
            </div>
            <div>
              <Label>Date</Label>
              <Input
                data-testid="fx-date"
                type="date"
                value={fx.date}
                onChange={(e) => setFx((p) => ({ ...p, date: e.target.value }))}
                required
              />
            </div>
            <div>
              <Label>Rate</Label>
              <Input
                data-testid="fx-rate"
                type="number"
                step="any"
                placeholder="0.22"
                value={fx.rate}
                onChange={(e) => setFx((p) => ({ ...p, rate: e.target.value }))}
                required
              />
            </div>
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
            className="grid grid-cols-2 items-end gap-2 sm:grid-cols-4"
          >
            <div>
              <Label>Name</Label>
              <Input
                data-testid="invite-name"
                value={invite.name}
                onChange={(e) =>
                  setInvite((p) => ({ ...p, name: e.target.value }))
                }
                required
              />
            </div>
            <div>
              <Label>Email</Label>
              <Input
                data-testid="invite-email"
                type="email"
                value={invite.email}
                onChange={(e) =>
                  setInvite((p) => ({ ...p, email: e.target.value }))
                }
                required
              />
            </div>
            <div>
              <Label>Password</Label>
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
            </div>
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

        <MembersSection />

        <ProjectionAssumptionsSection />

        <Section
          eyebrow="Backup"
          title="Export your data"
          description="Download the full database as a SQLite file. Open it anywhere, or keep it as a backup."
        >
          <a href={`${API_URL}/export`}>
            <Button variant="outline">Export database (.db)</Button>
          </a>
        </Section>
      </div>
    </AppShell>
  );
}
