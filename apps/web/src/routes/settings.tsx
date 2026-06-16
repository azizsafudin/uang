import { useState, useEffect } from "react";
import { useForm, Controller } from "react-hook-form";
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
import { Label } from "@/components/ui/label";
import { CurrencySelect } from "@/components/currency-select";
import { useDestructiveAction } from "@/lib/use-destructive-action";
import { useSession } from "@/lib/auth";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog";

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

      <ResponsiveDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <ResponsiveDialogContent>
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>Replace all data?</ResponsiveDialogTitle>
          </ResponsiveDialogHeader>
          <ResponsiveDialogBody>
            <p className="text-sm text-muted-foreground">
              This permanently replaces every account, transaction, goal, and
              member with the contents of{" "}
              <span className="font-medium">{file?.name}</span>, and signs everyone
              out. This cannot be undone from the app.
            </p>
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter>
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
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
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

  // AI provider settings
  const [aiBaseUrl, setAiBaseUrl] = useState("");
  const [aiModel, setAiModel] = useState("");
  const [aiApiKey, setAiApiKey] = useState("");
  const [aiApiKeySet, setAiApiKeySet] = useState(false);
  const [aiTestMsg, setAiTestMsg] = useState("");

  // Market data provider (Alpha Vantage key)
  const [mdApiKey, setMdApiKey] = useState("");
  const [mdApiKeySet, setMdApiKeySet] = useState(false);
  const [mdTestMsg, setMdTestMsg] = useState("");

  const settingsQ = useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const { data, error } = await api.settings.get();
      if (error) throw new Error(String(error));
      return data;
    },
  });

  // Seed the AI inputs from the query data (not from queryFn side-effects), so
  // they populate even when the ["settings"] query is already cached elsewhere.
  const settingsData = settingsQ.data;
  useEffect(() => {
    if (settingsData && "aiBaseUrl" in settingsData) {
      setAiBaseUrl(settingsData.aiBaseUrl ?? "");
      setAiModel(settingsData.aiModel ?? "");
      setAiApiKeySet(!!settingsData.aiApiKeySet);
      setMdApiKeySet(!!settingsData.marketDataApiKeySet);
    }
  }, [settingsData]);

  async function saveAi() {
    const payload: { aiBaseUrl: string; aiModel: string; aiApiKey?: string } = {
      aiBaseUrl,
      aiModel,
    };
    if (aiApiKey) payload.aiApiKey = aiApiKey;
    const { error } = await api.settings.patch(payload);
    if (error) {
      setAiTestMsg("Save failed");
      return;
    }
    setAiApiKey("");
    setAiApiKeySet(aiApiKeySet || !!aiApiKey);
    setAiTestMsg("Saved");
    await qc.invalidateQueries({ queryKey: ["settings"] });
  }

  // Tests the values currently in the form (unsaved). Returns true on success;
  // on failure it sets the status message and returns false.
  async function runAiTest(): Promise<boolean> {
    const payload: { aiBaseUrl: string; aiModel: string; aiApiKey?: string } = {
      aiBaseUrl,
      aiModel,
    };
    if (aiApiKey) payload.aiApiKey = aiApiKey;
    const { data } = await api.settings.ai.test.post(payload);
    if (data && "ok" in data && data.ok) return true;
    setAiTestMsg(
      data && "ok" in data && "message" in data && typeof data.message === "string"
        ? `Failed: ${data.message}`
        : "Failed: error",
    );
    return false;
  }

  async function testAi() {
    setAiTestMsg("Testing…");
    if (await runAiTest()) setAiTestMsg("Connection ok");
  }

  async function testAndSaveAi() {
    setAiTestMsg("Testing…");
    if (await runAiTest()) await saveAi();
  }

  async function removeAi() {
    const { error } = await api.settings.patch({ clearAi: true });
    if (error) { setAiTestMsg("Couldn't remove the provider"); return; }
    setAiBaseUrl(""); setAiModel(""); setAiApiKey(""); setAiApiKeySet(false);
    setAiTestMsg("Provider removed");
    await qc.invalidateQueries({ queryKey: ["settings"] });
  }

  async function saveMarketData() {
    const payload: { marketDataApiKey?: string } = {};
    if (mdApiKey) payload.marketDataApiKey = mdApiKey;
    const { error } = await api.settings.patch(payload);
    if (error) { setMdTestMsg("Save failed"); return; }
    setMdApiKey("");
    setMdApiKeySet(mdApiKeySet || !!mdApiKey);
    setMdTestMsg("Saved");
    await qc.invalidateQueries({ queryKey: ["settings"] });
  }

  // Tests the key currently in the form (unsaved). Returns true on success;
  // on failure it sets the status message and returns false.
  async function runMarketDataTest(): Promise<boolean> {
    const { data } = await api["market-data"].test.post(
      mdApiKey ? { marketDataApiKey: mdApiKey } : {},
    );
    if (data && "ok" in data && data.ok) return true;
    setMdTestMsg(
      data && "ok" in data && "message" in data && typeof data.message === "string"
        ? `Failed: ${data.message}`
        : "Failed: error",
    );
    return false;
  }

  async function testMarketData() {
    setMdTestMsg("Testing…");
    if (await runMarketDataTest()) setMdTestMsg("Connection ok");
  }

  async function testAndSaveMarketData() {
    setMdTestMsg("Testing…");
    if (await runMarketDataTest()) await saveMarketData();
  }

  async function removeMarketData() {
    const { error } = await api.settings.patch({ clearMarketData: true });
    if (error) { setMdTestMsg("Couldn't remove the key"); return; }
    setMdApiKey(""); setMdApiKeySet(false); setMdTestMsg("Key removed");
    await qc.invalidateQueries({ queryKey: ["settings"] });
  }

  const aiConfigured = !!(aiBaseUrl || aiModel || aiApiKeySet);
  const { confirm, dialog: confirmDialog } = useDestructiveAction();

  const fxForm = useForm<{ currency: string; date: string; rate: string }>({
    defaultValues: { currency: "", date: new Date().toISOString().slice(0, 10), rate: "" },
  });
  const inviteForm = useForm<{ email: string; name: string; password: string }>({
    defaultValues: { email: "", name: "", password: "" },
  });

  async function addFx(values: { currency: string; date: string; rate: string }) {
    const rate = parseFloat(values.rate);
    if (Number.isNaN(rate)) return;
    await fxCollection.insert({
      id: newId(),
      currency: values.currency.toUpperCase(),
      date: values.date,
      rateScaled: Math.round(rate * Number(SCALE)),
      source: "manual",
      createdAt: Math.floor(Date.now() / 1000),
    });
    fxForm.reset({ currency: "", date: values.date, rate: "" });
  }

  async function addUser(values: { email: string; name: string; password: string }) {
    await api.users.post(values);
    await qc.invalidateQueries({ queryKey: ["users"] });
    inviteForm.reset();
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
            onSubmit={fxForm.handleSubmit(addFx)}
            className="grid grid-cols-2 items-end gap-4 sm:grid-cols-4"
          >
            <Field label="Currency">
              <Controller
                control={fxForm.control}
                name="currency"
                render={({ field }) => (
                  <CurrencySelect
                    data-testid="fx-currency"
                    value={field.value}
                    placeholder="Select"
                    onValueChange={(code) => field.onChange(code)}
                  />
                )}
              />
            </Field>
            <Field label="Date">
              <Input
                data-testid="fx-date"
                type="date"
                required
                {...fxForm.register("date", { required: true })}
              />
            </Field>
            <Field label="Rate">
              <Input
                data-testid="fx-rate"
                type="number"
                step="any"
                placeholder="0.22"
                required
                {...fxForm.register("rate", { required: true })}
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
            onSubmit={inviteForm.handleSubmit(addUser)}
            className="grid grid-cols-2 items-end gap-4 sm:grid-cols-4"
          >
            <Field label="Name">
              <Input
                data-testid="invite-name"
                required
                {...inviteForm.register("name", { required: true })}
              />
            </Field>
            <Field label="Email">
              <Input
                data-testid="invite-email"
                type="email"
                required
                {...inviteForm.register("email", { required: true })}
              />
            </Field>
            <Field label="Password">
              <Input
                data-testid="invite-password"
                type="password"
                minLength={8}
                required
                {...inviteForm.register("password", { required: true, minLength: 8 })}
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

        <Section
          eyebrow="Integration"
          title="AI/LLM Provider"
          description="Point at a local model (e.g. Ollama http://localhost:11434/v1) or a cloud endpoint. Required for statement import. A cloud URL sends sample statement text to that provider; a local URL keeps it on this machine."
        >
          <div className="grid gap-3 sm:max-w-lg">
            <Field label="Base URL">
              <Input
                value={aiBaseUrl}
                onChange={(e) => setAiBaseUrl(e.target.value)}
                placeholder="http://localhost:11434/v1"
                data-testid="ai-base-url"
              />
            </Field>
            <Field label="Model">
              <Input
                value={aiModel}
                onChange={(e) => setAiModel(e.target.value)}
                placeholder="llama3.1"
                data-testid="ai-model"
              />
            </Field>
            <Field
              label={
                <>
                  API key{" "}
                  {aiApiKeySet && (
                    <Label className="text-muted-foreground font-normal">
                      (set — leave blank to keep)
                    </Label>
                  )}
                </>
              }
            >
              <Input
                type="password"
                value={aiApiKey}
                onChange={(e) => setAiApiKey(e.target.value)}
                placeholder={aiApiKeySet ? "••••••••" : "optional"}
                data-testid="ai-api-key"
              />
            </Field>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={testAi}
                data-testid="ai-test"
              >
                Test connection
              </Button>
              <Button onClick={testAndSaveAi} data-testid="ai-save">
                Test connection and Save
              </Button>
              {aiConfigured && (
                <Button
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={() => confirm({
                    title: "Remove AI provider?",
                    description: "This deletes the base URL, model, and API key. Statement import will be disabled until you set it up again.",
                    confirmLabel: "Remove",
                    onConfirm: removeAi,
                  })}
                  data-testid="ai-remove"
                >
                  Remove
                </Button>
              )}
              {aiTestMsg && (
                <span className="text-sm text-muted-foreground">
                  {aiTestMsg}
                </span>
              )}
            </div>
          </div>
        </Section>

        <Section
          eyebrow="Market data"
          title="Market data provider"
          description="Optional. Prices come from Yahoo and FX from Frankfurter — both free, no key needed. Add an Alpha Vantage API key only to use it as a fallback for instruments Yahoo can't resolve."
        >
          <div className="grid gap-3 sm:max-w-lg">
            <Field
              label={
                <>
                  Alpha Vantage API key{" "}
                  {mdApiKeySet && (
                    <Label className="text-muted-foreground font-normal">
                      (set — leave blank to keep)
                    </Label>
                  )}
                </>
              }
            >
              <Input
                type="password"
                value={mdApiKey}
                onChange={(e) => setMdApiKey(e.target.value)}
                placeholder={mdApiKeySet ? "••••••••" : "optional"}
                data-testid="md-api-key"
              />
            </Field>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={testMarketData} data-testid="md-test">
                Test connection
              </Button>
              <Button onClick={testAndSaveMarketData} data-testid="md-save">
                Test connection and Save
              </Button>
              {mdApiKeySet && (
                <Button
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={() => confirm({
                    title: "Remove Alpha Vantage key?",
                    description: "This deletes the stored key. Instrument prices will use Yahoo only.",
                    confirmLabel: "Remove",
                    onConfirm: removeMarketData,
                  })}
                  data-testid="md-remove"
                >
                  Remove
                </Button>
              )}
              {mdTestMsg && <span className="text-sm text-muted-foreground">{mdTestMsg}</span>}
            </div>
          </div>
        </Section>

        <RestoreSection />
      </div>
      {confirmDialog}
    </AppShell>
  );
}
