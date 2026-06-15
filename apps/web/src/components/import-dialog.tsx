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
import type { CsvParserConfig, PdfParserConfig } from "../../../api/src/lib/import/types";

type Candidate = { parserId: string; name: string; score: number; confident: boolean };
type Detect = { fingerprint: unknown; candidates: Candidate[] };
type Format = "csv" | "pdf";

type ExtractSuccess = { text: string; fingerprint: unknown; candidates: Candidate[] };

// The /imports/extract handler uses an untyped Elysia context, so Eden infers a
// loose union for `data` (success shape | error shape) where `text`/`candidates`
// stay possibly-undefined. Narrow the dynamic value with a precise guard.
function isExtractSuccess(data: unknown): data is ExtractSuccess {
  if (typeof data !== "object" || data === null) return false;
  if (!("text" in data) || !("candidates" in data)) return false;
  return typeof data.text === "string" && Array.isArray(data.candidates);
}

const NEW_PARSER = "__new__";

type PreviewRow = { date: string | null; amountMinor: number | null; description: string };
type PreviewError = { raw: Record<string, string>; reason: string };
type Preview = { rows: PreviewRow[]; total: number; errorCount: number; errors: PreviewError[] };

function arrayBufferToBase64(buf: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function ImportDialog({ accountId, accountCurrency }: { accountId: string; accountCurrency: string }) {
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<Format>("csv");
  const [filename, setFilename] = useState("");
  const [content, setContent] = useState("");          // CSV text, or PDF-extracted text
  const [pdfFingerprint, setPdfFingerprint] = useState<unknown>(null);
  const [detect, setDetect] = useState<Detect | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [parserId, setParserId] = useState<string>("");
  const [batchId, setBatchId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fileError, setFileError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // CSV new-parser column mapping fields
  const [name, setName] = useState("");
  const [dateCol, setDateCol] = useState("");
  const [dateFmt, setDateFmt] = useState("YYYY-MM-DD");
  const [descCol, setDescCol] = useState("");
  const [amountCol, setAmountCol] = useState("");
  const [sign, setSign] = useState<"negativeIsDebit" | "positiveIsDebit">("negativeIsDebit");

  // PDF new-parser regex mapping fields
  const [txnLine, setTxnLine] = useState("");
  const [startAfter, setStartAfter] = useState("");
  const [stopAt, setStopAt] = useState("");
  const [multiline, setMultiline] = useState(false);

  // AI state
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMsg, setAiMsg] = useState("");
  const [refineText, setRefineText] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);

  useEffect(() => {
    api.settings.get().then(({ data }) => {
      if (data && "aiBaseUrl" in data) setAiEnabled(!!data.aiBaseUrl && !!data.aiModel);
    }).catch(() => {});
  }, []);

  function reset() {
    setFormat("csv"); setFilename(""); setContent(""); setPdfFingerprint(null); setDetect(null);
    setHeaders([]); setParserId(""); setBatchId(null); setFileError("");
    setName(""); setDateCol(""); setDescCol(""); setAmountCol("");
    setDateFmt("YYYY-MM-DD"); setSign("negativeIsDebit");
    setTxnLine(""); setStartAfter(""); setStopAt(""); setMultiline(false);
    setAiBusy(false); setAiMsg(""); setRefineText(""); setPreview(null);
  }

  async function handleFile(file: File) {
    setFileError("");
    const isPdf = file.name.toLowerCase().endsWith(".pdf") || file.type === "application/pdf";
    if (isPdf) {
      setFormat("pdf");
      setFilename(file.name);
      const b64 = arrayBufferToBase64(await file.arrayBuffer());
      const { data, error } = await api.imports.extract.post({ filename: file.name, file: b64 });
      if (error || !isExtractSuccess(data)) {
        const code = (error && typeof error === "object" && "value" in error
          ? (error.value as { error?: string }).error : undefined);
        setFileError(
          code === "pdf_encrypted" ? "Remove the password and re-upload."
          : code === "pdf_no_text" ? "This looks like a scanned PDF — OCR isn't supported yet."
          : "Couldn't read this PDF.",
        );
        return;
      }
      setContent(data.text);
      setPdfFingerprint(data.fingerprint);
      setDetect({ fingerprint: data.fingerprint, candidates: data.candidates });
      const top = data.candidates.find((c) => c.confident) ?? data.candidates[0];
      setParserId(top ? top.parserId : NEW_PARSER);
      return;
    }
    setFormat("csv");
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

  function buildCsvConfig(): CsvParserConfig {
    return {
      version: 1, format: "csv",
      csv: { delimiter: ",", headerRow: 0, skipRows: 0 },
      fields: {
        date: { column: dateCol, format: dateFmt },
        description: { column: descCol },
        amount: { mode: "single", column: amountCol, decimal: ".", thousands: ",", sign },
      },
      rowFilter: { dropIfBlank: ["date", "amount"] },
    };
  }

  function buildPdfConfig(): PdfParserConfig {
    const cfg: PdfParserConfig = {
      version: 1, format: "pdf",
      transactionLine: txnLine,
      date: { format: dateFmt },
      amount: { decimal: ".", thousands: ",", sign },
    };
    if (startAfter || stopAt) cfg.region = { ...(startAfter ? { startAfter } : {}), ...(stopAt ? { stopAt } : {}) };
    if (multiline) cfg.multiline = { continuationAppendsTo: "description" };
    return cfg;
  }

  function buildConfig(): CsvParserConfig | PdfParserConfig {
    return format === "pdf" ? buildPdfConfig() : buildCsvConfig();
  }

  function applyConfig(cfg: CsvParserConfig | PdfParserConfig) {
    if (cfg.format === "pdf") {
      setTxnLine(cfg.transactionLine);
      setDateFmt(cfg.date.format);
      setSign(cfg.amount.sign);
      setStartAfter(cfg.region?.startAfter ?? "");
      setStopAt(cfg.region?.stopAt ?? "");
      setMultiline(cfg.multiline?.continuationAppendsTo === "description");
      return;
    }
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
    const csvReady = format === "csv" && dateCol && descCol && amountCol;
    const pdfReady = format === "pdf" && txnLine;
    if (!content || !needsMapping || (!csvReady && !pdfReady)) {
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
  }, [content, parserId, format, dateCol, dateFmt, descCol, amountCol, sign, txnLine, startAfter, stopAt, multiline, accountCurrency]);

  async function runRefine(instruction: string) {
    setAiBusy(true);
    try {
      const { data, error } = await api["import-parsers"].refine.post({
        content, config: buildConfig(), format, instruction, errors: preview?.errors ?? [],
      });
      if (error || !data || !("config" in data)) { setAiMsg("Refine failed"); return; }
      applyConfig(data.config);
      setRefineText("");
      setAiMsg("");
    } finally {
      setAiBusy(false);
    }
  }

  async function generate() {
    setAiBusy(true);
    try {
      const { data, error } = await api["import-parsers"].synthesize.post({ content, format });
      if (error || !data || !("config" in data)) { setAiMsg("AI couldn't generate — map manually"); return; }
      applyConfig(data.config);
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
        const fingerprint = format === "pdf"
          ? (pdfFingerprint ?? { format: "pdf", markers: [] })
          : { format: "csv", delimiter: ",", headerColumns: [...headers].map((h) => h.toLowerCase()).sort() };
        const { data, error } = await api["import-parsers"].post({
          name: name || filename, sourceFormat: format, config: buildConfig(), fingerprint, origin: "manual",
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
  const mappingReady = format === "pdf" ? !!txnLine : !!(dateCol && descCol && amountCol);
  const canRun = content !== "" && (!needsMapping || mappingReady);

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger render={<Button variant="outline" />}>Import statement</DialogTrigger>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader><DialogTitle>Import statement (CSV or PDF)</DialogTitle></DialogHeader>

        {batchId ? (
          <ImportReview batchId={batchId} accountCurrency={accountCurrency} onDone={() => { setOpen(false); reset(); }} />
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Statement file</Label>
              <div
                data-testid="import-dropzone"
                onDragOver={(e) => { e.preventDefault(); }}
                onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) void handleFile(f); }}
                onClick={() => fileInputRef.current?.click()}
                className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-input py-8 text-center text-sm text-muted-foreground hover:border-ring"
              >
                <span className="text-base">&#8593; Drop your statement here</span>
                <span>or click to browse (.csv, .pdf){filename ? ` — ${filename}` : ""}</span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,text/csv,.pdf,application/pdf"
                  className="hidden"
                  data-testid="import-file"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); }}
                />
              </div>
              {fileError && <p className="text-sm text-destructive" data-testid="import-file-error">{fileError}</p>}
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
                      onClick={() => void generate()}
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

                  {format === "pdf" ? (
                    <>
                      <div className="col-span-2 space-y-1">
                        <Label>Transaction line regex</Label>
                        <Input value={txnLine} onChange={(e) => setTxnLine(e.target.value)}
                          placeholder="^(?<date>\\d{2}/\\d{2}/\\d{4})\\s+(?<description>.+?)\\s+(?<amount>-?[\\d,]+\\.\\d{2})$"
                          data-testid="map-txnline" />
                      </div>
                      <div className="space-y-1">
                        <Label>Date format</Label>
                        <Input value={dateFmt} onChange={(e) => setDateFmt(e.target.value)} data-testid="map-dateformat" />
                      </div>
                      <SignSelect sign={sign} setSign={setSign} />
                      <div className="space-y-1">
                        <Label>Region start (regex, optional)</Label>
                        <Input value={startAfter} onChange={(e) => setStartAfter(e.target.value)} data-testid="map-startafter" />
                      </div>
                      <div className="space-y-1">
                        <Label>Region stop (regex, optional)</Label>
                        <Input value={stopAt} onChange={(e) => setStopAt(e.target.value)} data-testid="map-stopat" />
                      </div>
                      <label className="col-span-2 flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={multiline} onChange={(e) => setMultiline(e.target.checked)} data-testid="map-multiline" />
                        Append non-matching lines to the previous description
                      </label>
                    </>
                  ) : (
                    <>
                      <ColumnPick label="Date column" value={dateCol} set={setDateCol} headers={headers} testId="map-date" />
                      <div className="space-y-1">
                        <Label>Date format</Label>
                        <Input value={dateFmt} onChange={(e) => setDateFmt(e.target.value)} data-testid="map-dateformat" />
                      </div>
                      <ColumnPick label="Description column" value={descCol} set={setDescCol} headers={headers} testId="map-desc" />
                      <ColumnPick label="Amount column" value={amountCol} set={setAmountCol} headers={headers} testId="map-amount" />
                      <SignSelect sign={sign} setSign={setSign} />
                    </>
                  )}
                </div>

                {preview && (
                  <div className="space-y-1 rounded-md border p-2 text-sm">
                    <div className="flex justify-between text-muted-foreground">
                      <span>Preview</span>
                      <span>{preview.total - preview.errorCount} ok &middot; {preview.errorCount} errors</span>
                    </div>
                    {preview.total === 0 && (
                      <p className="text-muted-foreground">
                        No transactions matched — check the {format === "pdf" ? "transaction-line regex and region anchors" : "column mapping"}
                        {aiEnabled ? ", or use Refine to fix it" : ""}.
                      </p>
                    )}
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
                    <Button type="button" variant="outline" disabled={aiBusy || !content} data-testid="ai-refine"
                      onClick={() => void runRefine(refineText)}>
                      Refine
                    </Button>
                    {preview && preview.errorCount > 0 && (
                      <Button type="button" variant="ghost" disabled={aiBusy} data-testid="ai-fix-errors"
                        onClick={() => void runRefine("Fix the rows that failed to parse.")}>
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

function SignSelect({ sign, setSign }: {
  sign: "negativeIsDebit" | "positiveIsDebit";
  setSign: (v: "negativeIsDebit" | "positiveIsDebit") => void;
}) {
  return (
    <div className="space-y-1">
      <Label>Amount sign</Label>
      <Select value={sign} onValueChange={(v: string | null) => v && setSign(v === "positiveIsDebit" ? "positiveIsDebit" : "negativeIsDebit")}>
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
