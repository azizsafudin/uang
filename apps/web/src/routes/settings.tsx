import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { SCALE } from "@uang/shared";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

type FxRate = {
  id: string;
  currency: string;
  date: string;
  rateScaled: number;
  createdAt: number;
};

type User = {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
};

export function SettingsPage() {
  const qc = useQueryClient();

  const fxQ = useQuery({
    queryKey: ["fx"],
    queryFn: async (): Promise<FxRate[]> => {
      const { data, error } = await api.fx.get();
      if (error) throw new Error(String(error));
      return (data as unknown as FxRate[]) ?? [];
    },
  });

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
  const [invite, setInvite] = useState({
    email: "",
    name: "",
    password: "",
  });

  async function addFx(e: React.FormEvent) {
    e.preventDefault();
    const rate = parseFloat(fx.rate);
    if (Number.isNaN(rate)) return;
    await api.fx.post({
      currency: fx.currency.toUpperCase(),
      date: fx.date,
      rateScaled: Math.round(rate * Number(SCALE)),
    });
    await qc.invalidateQueries();
    setFx((prev) => ({ ...prev, currency: "", rate: "" }));
  }

  async function addUser(e: React.FormEvent) {
    e.preventDefault();
    await api.users.post(invite);
    await qc.invalidateQueries({ queryKey: ["users"] });
    setInvite({ email: "", name: "", password: "" });
  }

  return (
    <div className="min-h-screen p-6 md:p-8 max-w-2xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <Link to="/">
          <Button variant="outline">← Back</Button>
        </Link>
      </div>

      <Card>
        <CardHeader>
          <h2 className="font-medium">Exchange rates (to base currency)</h2>
        </CardHeader>
        <CardContent className="space-y-3">
          <form onSubmit={addFx} className="grid grid-cols-4 gap-2 items-end">
            <div>
              <Label>Currency</Label>
              <Input
                value={fx.currency}
                maxLength={3}
                onChange={(e) =>
                  setFx((p) => ({ ...p, currency: e.target.value }))
                }
                required
              />
            </div>
            <div>
              <Label>Date</Label>
              <Input
                type="date"
                value={fx.date}
                onChange={(e) =>
                  setFx((p) => ({ ...p, date: e.target.value }))
                }
                required
              />
            </div>
            <div>
              <Label>Rate</Label>
              <Input
                type="number"
                step="any"
                value={fx.rate}
                onChange={(e) =>
                  setFx((p) => ({ ...p, rate: e.target.value }))
                }
                required
              />
            </div>
            <Button type="submit">Add</Button>
          </form>
          <div className="space-y-1">
            {(fxQ.data ?? []).map((r) => (
              <div
                key={r.id}
                className="flex justify-between text-sm items-center"
              >
                <span>
                  {r.currency} @ {r.date}
                </span>
                <span className="tabular-nums flex items-center gap-2">
                  {(r.rateScaled / Number(SCALE)).toString()}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      await api.fx({ id: r.id }).delete();
                      await qc.invalidateQueries({ queryKey: ["fx"] });
                    }}
                  >
                    ✕
                  </Button>
                </span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="font-medium">Household members</h2>
        </CardHeader>
        <CardContent className="space-y-3">
          <form
            onSubmit={addUser}
            className="grid grid-cols-4 gap-2 items-end"
          >
            <div>
              <Label>Name</Label>
              <Input
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
          <div className="space-y-1">
            {(usersQ.data ?? []).map((u) => (
              <div key={u.id} className="flex justify-between text-sm">
                <span>
                  {u.name} · {u.email}
                </span>
                <span className="text-muted-foreground">
                  {u.isAdmin ? "admin" : "member"}
                </span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="font-medium">Backup</h2>
        </CardHeader>
        <CardContent>
          <a href={`${API_URL}/export`}>
            <Button variant="outline">Export database (.db)</Button>
          </a>
        </CardContent>
      </Card>
    </div>
  );
}
