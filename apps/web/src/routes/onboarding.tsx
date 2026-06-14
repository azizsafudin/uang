import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { api } from "@/lib/api";
import { signIn } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function OnboardingPage() {
  const nav = useNavigate();
  const [form, setForm] = useState({ householdName: "", baseCurrency: "MYR", name: "", email: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const { error } = await api.onboarding.init.post(form);
    if (error) { setError("Could not initialize. Is it already set up?"); return; }
    // Sign in with the credentials just provided, then go straight to the dashboard.
    const signedIn = await signIn.email({ email: form.email, password: form.password });
    await nav({ to: signedIn.error ? "/login" : "/" });
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Set up your household</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-3">
            <div><Label>Household name</Label><Input value={form.householdName} onChange={set("householdName")} required /></div>
            <div><Label>Base currency (ISO)</Label><Input value={form.baseCurrency} onChange={set("baseCurrency")} maxLength={3} required /></div>
            <div><Label>Your name</Label><Input value={form.name} onChange={set("name")} required /></div>
            <div><Label>Email</Label><Input type="email" value={form.email} onChange={set("email")} required /></div>
            <div><Label>Password</Label><Input type="password" value={form.password} onChange={set("password")} minLength={8} required /></div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <Button type="submit" className="w-full">Create household</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
