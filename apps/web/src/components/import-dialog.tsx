import { useState, useEffect, useRef } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ImportReview } from "@/components/import-review";
import type { CsvParserConfig } from "../../../api/src/lib/import/types";

type Candidate = { parserId: string; name: string; score: number; confident: boolean };
type Detect = { fingerprint: { headerColumns: string[] }; candidates: Candidate[] };

const NEW_PARSER = "__new__";

type PreviewRow = { date: string | null; amountMinor: number | null; description: string };
type PreviewError = { raw: Record<string, string>; reason: string };
type Preview = { rows: PreviewRow[]; total: number; errorCount: number; errors: PreviewError[] };

export function ImportDialog({ accountId, accountCurrency }: { accountId: string; accountCurrency: string }) {
  const [open, setOpen] = useState(false);
  const [filename, setFilename] = useState("");
  const [content, setContent] = useState("");
  const [detect, setDetect] = useState<Detect | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [parserId, setParserId] = useState<string>("");
  const [batchId, setBatchId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // New-parser column mapping fields
  const [name, setName] = useState("");
  const [dateCol, setDateCol] = useState("");
  const [dateFmt, setDateFmt] = useState("YYYY-MM-DD");
  const [descCol, setDescCol] = useState("");
  const [amountCol, setAmountCol] = useState("");
  const [sign, setSign] = useState<"negativeIsDebit" | "positiveIsDebit">("negativeIsDebit");

  // AI state
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMsg, setAiMsg] = useState("");
  const [refineText, setRefineText] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);

  // Load AI availability on mount
  useEffect(() => {
    api.settings.get().then(({ data }) => {
      if (data && "aiBaseUrl" in data) setAiEnabled(!!data.aiBaseUrl && !!data.aiModel);
    }).catch(() => {});
  }, []);

  function reset() {
    setFilename(""); setContent(""); setDetect(null); setHeaders([]); setParserId("");
    setBatchId(null); setName(""); setDateCol(""); setDescCol(""); setAmountCol("");
    setDateFmt("YYYY-MM-DD"); setSign("negativeIsDebit");
    setAiBusy(false); setAiMsg(""); setRefineText(""); setPreview(null);
  }

  async function handleFile(file: File) {
    const text = await file.text();
    setFilename(file.name); setContent(text);
    const firstLine = text.split(/\r?\n/)[0] ?? "";
    setHeaders(firstLine.split(",").map((h) => h.trim()).filter(Boolean));
    const { data } = await api.imports.detect.post({ filename: file.name, content: text });
    if (data && "candidates" in data) {
      setDetect(data);
      const top = data.candidates.find((c) => c.confident) ?? data.candidates[0];
      setParserId(top ? top.parserId : NEW_PARSER);
    } else {
      setParserId(NEW_PARSER);
    }
  }

  function buildConfig() {
    return {
      version: 1 as const, format: "csv" as const,
      csv: { delimiter: ",", headerRow: 0, skipRows: 0 },
      fields: {
        date: { column: dateCol, format: dateFmt },
        description: { column: descCol },
        amount: { mode: "single" as const, column: amountCol, decimal: ".", thousands: ",", sign },
      },
      rowFilter: { dropIfBlank: ["date" as const, "amount" as const] },
    };
  }

  function applyConfig(cfg: CsvParserConfig) {
    setDateCol(cfg.fields.date.column);
    setDateFmt(cfg.fields.date.format);
    setDescCol(cfg.fields.description.column);
    if (cfg.fields.amount.mode === "single") {
      setAmountCol(cfg.fields.amount.column);
      setSign(cfg.fields.amount.sign === "positiveIsDebit" ? "positiveIsDebit" : "negativeIsDebit");
    }
  }

  // Live preview — debounced whenever mapping changes
  useEffect(() => {
    const needsMapping = parserId === NEW_PARSER;
    if (!content || !needsMapping || !dateCol || !descCol || !amountCol) {
      setPreview(null);
      return;
    }
    const cfg = buildConfig();
    const t = setTimeout(() => {
      void (async () => {
        const { data } = await api["import-parsers"].preview.post({ content, config: cfg, currency: accountCurrency });
        if (data && "rows" in data && data.rows !== undefined) {
          setPreview({ rows: data.rows, total: data.total, errorCount: data.errorCount, errors: data.errors ?? [] });
        }
      })();
    }, 400);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, parserId, dateCol, dateFmt, descCol, amountCol, sign, accountCurrency]);

  async function runRefine(instruction: string) {
    setAiBusy(true);
    try {
      const { data, error } = await api["import-parsers"].refine.post({
        content, config: buildConfig(), instruction, errors: preview?.errors ?? [],
      });
      if (error || !data || !("config" in data)) { setAiMsg("Refine failed"); return; }
      if (data.config.format !== "csv") { setAiMsg("Refine returned a non-CSV config"); return; }
      applyConfig(data.config);
      setRefineText("");
      setAiMsg("");
    } finally {
      setAiBusy(false);
    }
  }

  async function run() {
    setBusy(true);
    try {
      let useParserId = parserId;
      if (parserId === NEW_PARSER) {
        const fingerprint = { format: "csv" as const, delimiter: ",", headerColumns: [...headers].map((h) => h.toLowerCase()).sort() };
        const { data, error } = await api["import-parsers"].post({
          name: name || filename, sourceFormat: "csv", config: buildConfig(), fingerprint, origin: "manual",
        });
        if (error || !data || !("id" in data)) throw new Error(String(error ?? "parser create failed"));
        useParserId = data.id;
      }
      const { data, error } = await api.accounts({ id: accountId }).imports.post({ filename, content, parserId: useParserId });
      if (error || !data || !("id" in data) || !data.id) throw new Error(String(error ?? "import failed"));
      setBatchId(data.id);
    } finally {
      setBusy(false);
    }
  }

  const needsMapping = parserId === NEW_PARSER;
  const canRun = content !== "" && (!needsMapping || (dateCol && descCol && amountCol));

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger render={<Button variant="outline" />}>Import statement</DialogTrigger>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader><DialogTitle>Import statement (CSV)</DialogTitle></DialogHeader>

        {batchId ? (
          <ImportReview batchId={batchId} accountCurrency={accountCurrency} onDone={() => { setOpen(false); reset(); }} />
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>CSV file</Label>
              <div
                data-testid="import-dropzone"
                onDragOver={(e) => { e.preventDefault(); }}
                onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) void handleFile(f); }}
                onClick={() => fileInputRef.current?.click()}
                className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-input py-8 text-center text-sm text-muted-foreground hover:border-ring"
              >
                <span className="text-base">&#8593; Drop your statement here</span>
                <span>or click to browse (.csv){filename ? ` — ${filename}` : ""}</span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  data-testid="import-file"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); }}
                />
              </div>
            </div>

            {content && (
              <div className="space-y-2">
                <Label>Parser</Label>
                <Select value={parserId} onValueChange={(v: string | null) => v && setParserId(v)}>
                  <SelectTrigger data-testid="import-parser">
                    <SelectValue>
                      {(v: unknown) => {
                        const val = typeof v === "string" ? v : "";
                        if (!val) return "Choose a parser";
                        if (val === NEW_PARSER) return "Create a new parser…";
                        const c = detect?.candidates.find((x) => x.parserId === val);
                        return c
                          ? `${c.name}${c.confident ? " (match)" : ` (${Math.round(c.score * 100)}%)`}`
                          : "Choose a parser";
                      }}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {detect?.candidates.map((c) => (
                      <SelectItem key={c.parserId} value={c.parserId}>
                        {c.name}{c.confident ? " (match)" : ` (${Math.round(c.score * 100)}%)`}
                      </SelectItem>
                    ))}
                    <SelectItem value={NEW_PARSER}>Create a new parser…</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {needsMapping && (
              <div className="space-y-4">
                {aiEnabled && (
                  <div className="space-y-1">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!content || aiBusy}
                      data-testid="ai-generate"
                      onClick={async () => {
                        setAiBusy(true);
                        try {
                          const { data, error } = await api["import-parsers"].synthesize.post({ content });
                          if (error || !data || !("config" in data)) {
                            setAiMsg("AI couldn't generate — map manually");
                            return;
                          }
                          if (data.config.format !== "csv") { setAiMsg("AI couldn't generate — map manually"); return; }
                          applyConfig(data.config);
                          setAiMsg("");
                        } finally {
                          setAiBusy(false);
                        }
                      }}
                    >
                      {aiBusy ? "Generating…" : "✨ Generate with AI"}
                    </Button>
                    {aiMsg && <p className="text-sm text-muted-foreground">{aiMsg}</p>}
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2 space-y-1">
                    <Label>Parser name</Label>
                    <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={filename} data-testid="parser-name" />
                  </div>
                  <ColumnPick label="Date column" value={dateCol} set={setDateCol} headers={headers} testId="map-date" />
                  <div className="space-y-1">
                    <Label>Date format</Label>
                    <Input value={dateFmt} onChange={(e) => setDateFmt(e.target.value)} data-testid="map-dateformat" />
                  </div>
                  <ColumnPick label="Description column" value={descCol} set={setDescCol} headers={headers} testId="map-desc" />
                  <ColumnPick label="Amount column" value={amountCol} set={setAmountCol} headers={headers} testId="map-amount" />
                  <div className="space-y-1">
                    <Label>Amount sign</Label>
                    <Select value={sign} onValueChange={(v: string | null) => v && setSign(v as "negativeIsDebit" | "positiveIsDebit")}>
                      <SelectTrigger data-testid="map-sign">
                        <SelectValue>
                          {(v: unknown) => (String(v) === "positiveIsDebit" ? "Positive = money out" : "Negative = money out")}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="negativeIsDebit">Negative = money out</SelectItem>
                        <SelectItem value="positiveIsDebit">Positive = money out</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {preview && (
                  <div className="space-y-1 rounded-md border p-2 text-sm">
                    <div className="flex justify-between text-muted-foreground">
                      <span>Preview</span>
                      <span>{preview.total - preview.errorCount} ok &middot; {preview.errorCount} errors</span>
                    </div>
                    {preview.rows.map((r, i) => (
                      <div key={i} className="flex justify-between tabular-nums">
                        <span>{r.date ?? "—"}</span>
                        <span className="flex-1 truncate px-2">{r.description}</span>
                        <span>{r.amountMinor === null ? "—" : (r.amountMinor / 100).toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                )}

                {aiEnabled && (
                  <div className="flex items-center gap-2">
                    <Input
                      value={refineText}
                      onChange={(e) => setRefineText(e.target.value)}
                      placeholder="Tell the AI what's off…"
                      data-testid="ai-refine-input"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      disabled={aiBusy || !content}
                      data-testid="ai-refine"
                      onClick={() => void runRefine(refineText)}
                    >
                      Refine
                    </Button>
                    {preview && preview.errorCount > 0 && (
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={aiBusy}
                        data-testid="ai-fix-errors"
                        onClick={() => void runRefine("Fix the rows that failed to parse.")}
                      >
                        Ask AI to fix these
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )}

            <DialogFooter>
              <Button onClick={run} disabled={!canRun || busy} data-testid="import-run">
                {busy ? "Parsing…" : "Parse & review"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ColumnPick({ label, value, set, headers, testId }: {
  label: string; value: string; set: (v: string) => void; headers: string[]; testId: string;
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Select value={value} onValueChange={(v: string | null) => v && set(v)}>
        <SelectTrigger data-testid={testId}><SelectValue placeholder="Select column" /></SelectTrigger>
        <SelectContent>
          {headers.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}
