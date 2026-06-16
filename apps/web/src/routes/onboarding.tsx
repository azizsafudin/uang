import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { api } from "@/lib/api";
import { signIn } from "@/lib/auth";
import { invalidateAuthGate } from "@/lib/guards";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CurrencySelect } from "@/components/currency-select";

export function OnboardingPage() {
  const nav = useNavigate();
  const [form, setForm] = useState({
    householdName: "",
    baseCurrency: "MYR",
    name: "",
    email: "",
    password: "",
  });
  const [error, setError] = useState<string | null>(null);
  const set =
    (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const { error } = await api.onboarding.init.post(form);
    if (error) {
      setError("Could not initialize. Is it already set up?");
      return;
    }
    // Sign in with the credentials just provided, then go straight to the dashboard.
    const signedIn = await signIn.email({
      email: form.email,
      password: form.password,
    });
    await invalidateAuthGate();
    await nav({ to: signedIn.error ? "/login" : "/" });
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background p-4">
      <div className="text-center">
        <p className="font-heading text-3xl tracking-tight">
          uang<span className="text-gold">.</span>
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Track what you own, owe, and where you stand.
        </p>
      </div>
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="font-heading text-xl tracking-tight">
            Set up your household
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <Field label="Household name">
              <Input
                data-testid="onboarding-household"
                value={form.householdName}
                onChange={set("householdName")}
                placeholder="The Safudins"
                required
              />
            </Field>
            <Field label="Base currency" hint="The currency everything rolls up to.">
              <CurrencySelect
                data-testid="onboarding-currency"
                value={form.baseCurrency}
                onValueChange={(code) => setForm({ ...form, baseCurrency: code })}
              />
            </Field>
            <Field label="Your name" className="border-t border-border/70 pt-4">
              <Input data-testid="onboarding-name" value={form.name} onChange={set("name")} required />
            </Field>
            <Field label="Email">
              <Input
                data-testid="onboarding-email"
                type="email"
                value={form.email}
                onChange={set("email")}
                required
              />
            </Field>
            <Field label="Password">
              <Input
                data-testid="onboarding-password"
                type="password"
                value={form.password}
                onChange={set("password")}
                minLength={8}
                required
              />
            </Field>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full">
              Create household
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
