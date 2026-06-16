import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { signIn } from "@/lib/auth";
import { invalidateAuthGate } from "@/lib/guards";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function LoginPage() {
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const { error } = await signIn.email({ email, password });
    if (error) {
      setError("Invalid email or password.");
      return;
    }
    await invalidateAuthGate();
    await nav({ to: "/" });
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background p-4">
      <div className="text-center">
        <p className="font-heading text-3xl tracking-tight">
          uang<span className="text-gold">.</span>
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Your household's net worth, in one place.
        </p>
      </div>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="font-heading text-xl tracking-tight">
            Welcome back
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <Field label="Email">
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </Field>
            <Field label="Password">
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </Field>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full">
              Sign in
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
