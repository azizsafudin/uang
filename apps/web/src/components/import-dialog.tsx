import { useState } from "react";
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

type Candidate = { parserId: string; name: string; score: number; confident: boolean };
type Detect = { fingerprint: { headerColumns: string[] }; candidates: Candidate[] };

const NEW_PARSER = "__new__";

export function ImportDialog({ accountId, accountCurrency }: { accountId: string; accountCurrency: string }) {
  const [open, setOpen] = useState(false);
  const [filename, setFilename] = useState("");
  const [content, setContent] = useState("");
  const [detect, setDetect] = useState<Detect | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [parserId, setParserId] = useState<string>("");
  const [batchId, setBatchId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // New-parser column mapping fields
  const [name, setName] = useState("");
  const [dateCol, setDateCol] = useState("");
  const [dateFmt, setDateFmt] = useState("YYYY-MM-DD");
  const [descCol, setDescCol] = useState("");
  const [amountCol, setAmountCol] = useState("");
  const [sign, setSign] = useState<"negativeIsDebit" | "positiveIsDebit">("negativeIsDebit");

  function reset() {
    setFilename(""); setContent(""); setDetect(null); setHeaders([]); setParserId("");
    setBatchId(null); setName(""); setDateCol(""); setDescCol(""); setAmountCol("");
    setDateFmt("YYYY-MM-DD"); setSign("negativeIsDebit");
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
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
      <DialogContent className="max-w-3xl">
        <DialogHeader><DialogTitle>Import statement (CSV)</DialogTitle></DialogHeader>

        {batchId ? (
          <ImportReview batchId={batchId} accountCurrency={accountCurrency} onDone={() => { setOpen(false); reset(); }} />
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>CSV file</Label>
              <Input type="file" accept=".csv,text/csv" data-testid="import-file" onChange={onFile} />
            </div>

            {content && (
              <div className="space-y-2">
                <Label>Parser</Label>
                <Select value={parserId} onValueChange={(v: string | null) => v && setParserId(v)}>
                  <SelectTrigger data-testid="import-parser"><SelectValue placeholder="Choose a parser" /></SelectTrigger>
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
                  <Select value={sign} onValueChange={(v: string | null) => v && setSign(v as typeof sign)}>
                    <SelectTrigger data-testid="map-sign"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="negativeIsDebit">Negative = money out</SelectItem>
                      <SelectItem value="positiveIsDebit">Positive = money out</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
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
