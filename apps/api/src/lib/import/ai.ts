import { validateParserConfig } from "./validate";
import type { CsvParserConfig, PdfParserConfig } from "./types";

export interface AiConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export class AiError extends Error {
  constructor(public code: "ai_unavailable" | "ai_invalid_output", message?: string) {
    super(message ? `${code}: ${message}` : code);
    this.name = "AiError";
  }
}

// Extract choices[0].message.content from an OpenAI-compatible response without `any`.
function extractContent(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const msg = (choices[0] as { message?: unknown }).message;
  if (typeof msg !== "object" || msg === null) return null;
  const content = (msg as { content?: unknown }).content;
  return typeof content === "string" ? content : null;
}

// Parse a model's reply into a JSON object, tolerating the markdown code fences
// and stray prose some providers wrap around it (Claude often emits ```json … ```).
// Strips a fenced block if present, then slices to the outermost {...}.
export function extractJsonObject(content: string): unknown {
  let s = content.trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) s = fenced[1].trim();
  const open = s.indexOf("{");
  const close = s.lastIndexOf("}");
  if (open >= 0 && close > open) s = s.slice(open, close + 1);
  return JSON.parse(s);
}

// Low-level OpenAI-compatible chat call returning the parsed JSON object content.
export async function chatJson(
  cfg: AiConfig,
  system: string,
  user: string,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        // NOTE: we deliberately do NOT send `response_format: { type: "json_object" }`.
        // Anthropic's OpenAI-compat endpoint rejects it (400, wants "json_schema"), and
        // support varies across providers (Groq/Gemini/Ollama). The system prompt already
        // demands "reply with ONLY a JSON object", and extractJsonObject tolerates the
        // code fences some models (e.g. Claude) wrap around it — so this stays portable.
        temperature: 0,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new AiError("ai_unavailable", e instanceof Error ? e.message : "request failed");
  }
  if (!res.ok) throw new AiError("ai_unavailable", `provider returned ${res.status}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new AiError("ai_invalid_output", "non-JSON response");
  }
  const content = extractContent(body);
  if (content === null) throw new AiError("ai_invalid_output", "missing message content");
  try {
    return extractJsonObject(content);
  } catch {
    throw new AiError("ai_invalid_output", "content was not JSON");
  }
}

const CONFIG_SHAPE = `{
  "version": 1, "format": "csv",
  "csv": { "delimiter": ",", "headerRow": 0, "skipRows": 0 },
  "fields": {
    "date": { "column": "<header>", "format": "<tokens: YYYY YY MM M MMM DD D>" },
    "description": { "column": "<header>" },
    "amount": { "mode": "single", "column": "<header>", "decimal": ".", "thousands": ",", "sign": "negativeIsDebit|positiveIsDebit" }
  },
  "rowFilter": { "dropIfBlank": ["date", "amount"] }
}`;

const SYSTEM = `You convert a sample bank or credit-card CSV into a deterministic parser config.
Reply with ONLY a JSON object of exactly this shape (no prose):
${CONFIG_SHAPE}
Rules: use the real header names from the sample verbatim; infer the date format from the date
values using only the listed tokens; pick "sign" so money leaving the account is negative; if
debits and credits are in two separate columns, use {"mode":"debitCredit","debitColumn":...,
"creditColumn":...,"decimal":...,"thousands":...} instead of the single-amount shape.`;

// Cap a CSV sample to the header line + the first 20 data rows, so we never
// ship a whole statement file to the model.
export function capSample(content: string): string {
  return content.split(/\r?\n/).slice(0, 21).join("\n");
}

type Chat = (cfg: AiConfig, system: string, user: string) => Promise<unknown>;
const defaultChat: Chat = (cfg, s, u) => chatJson(cfg, s, u);

export async function synthesizeCsvConfig(
  sample: string,
  cfg: AiConfig,
  chat: Chat = defaultChat,
): Promise<CsvParserConfig> {
  const raw = await chat(cfg, SYSTEM, `Sample CSV (headers + rows):\n${sample}`);
  try {
    const cfg2 = validateParserConfig(raw);
    if (cfg2.format !== "csv") throw new Error("expected csv");
    return cfg2;
  } catch {
    throw new AiError("ai_invalid_output", "config failed validation");
  }
}

export async function refineCsvConfig(
  sample: string,
  current: CsvParserConfig,
  instruction: string,
  errors: Array<{ raw: Record<string, string>; reason: string }>,
  cfg: AiConfig,
  chat: Chat = defaultChat,
): Promise<CsvParserConfig> {
  const user = [
    `Sample CSV (headers + rows):\n${sample}`,
    `Current config:\n${JSON.stringify(current)}`,
    errors.length ? `Rows that failed to parse:\n${JSON.stringify(errors.slice(0, 10))}` : "",
    `Fix request: ${instruction || "Correct the rows that failed to parse."}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const raw = await chat(cfg, SYSTEM, user);
  try {
    const cfg2 = validateParserConfig(raw);
    if (cfg2.format !== "csv") throw new Error("expected csv");
    return cfg2;
  } catch {
    throw new AiError("ai_invalid_output", "config failed validation");
  }
}

const PDF_CONFIG_SHAPE = `{
  "version": 1, "format": "pdf",
  "region": { "startAfter": "<regex of a header line just ABOVE the transactions, or omit region>", "stopAt": "<regex of a line just AFTER the last transaction, or omit>" },
  "transactionLine": "<a single-line JS regex with named groups (?<date>...), (?<description>...), (?<amount>...) matching ONE transaction row>",
  "date": { "format": "<tokens: YYYY YY MM M MMM DD D>" },
  "amount": { "decimal": ".", "thousands": ",", "sign": "negativeIsDebit|positiveIsDebit" },
  "multiline": { "continuationAppendsTo": "description" }
}`;

const PDF_SYSTEM = `You convert sample text extracted from a bank or credit-card PDF statement into a deterministic parser config.
Reply with ONLY a JSON object of exactly this shape (no prose):
${PDF_CONFIG_SHAPE}
Rules: "transactionLine" must be a single-line JS regex containing named groups (?<date>) and (?<amount>) (and (?<description>) when a description exists); it must match exactly one transaction row from the sample. Infer "date.format" from the date values using only the listed tokens. For "region.startAfter"/"region.stopAt", pick anchors that appear EXACTLY ONCE, on the lines immediately around the transaction rows (e.g. the column-header line just above the first row) — NEVER a phrase that also shows up in a table of contents, index, summary, or page header/footer, since the anchor matches its FIRST occurrence in the document. If no anchor is reliably unique to the transaction section, OMIT "region" entirely. Pick "sign" so money leaving the account is negative. Keep the regex simple: NEVER use nested quantifiers like (a+)+ or (\\d+)*.`;

// Cap extracted statement text to ~8 KB on a line boundary before sending to the model.
export function capPdfSample(text: string): string {
  if (text.length <= 8000) return text;
  const cut = text.slice(0, 8000);
  const lastNl = cut.lastIndexOf("\n");
  return (lastNl > 0 ? cut.slice(0, lastNl) : cut).replace(/\s+$/, "");
}

function asPdfConfig(raw: unknown): PdfParserConfig {
  const validated = validateParserConfig(raw);
  if (validated.format !== "pdf") throw new AiError("ai_invalid_output", "expected a pdf config");
  return validated;
}

export async function synthesizePdfConfig(
  sample: string,
  cfg: AiConfig,
  chat: Chat = defaultChat,
): Promise<PdfParserConfig> {
  const raw = await chat(cfg, PDF_SYSTEM, `Sample statement text:\n${sample}`);
  try {
    return asPdfConfig(raw);
  } catch (e) {
    if (e instanceof AiError) throw e;
    throw new AiError("ai_invalid_output", "config failed validation");
  }
}

export async function refinePdfConfig(
  sample: string,
  current: PdfParserConfig,
  instruction: string,
  errors: Array<{ raw: Record<string, string>; reason: string }>,
  cfg: AiConfig,
  chat: Chat = defaultChat,
): Promise<PdfParserConfig> {
  const user = [
    `Sample statement text:\n${sample}`,
    `Current config:\n${JSON.stringify(current)}`,
    errors.length ? `Lines that failed to parse:\n${JSON.stringify(errors.slice(0, 10))}` : "",
    `Fix request: ${instruction || "Correct the lines that failed to parse."}`,
  ].filter(Boolean).join("\n\n");
  const raw = await chat(cfg, PDF_SYSTEM, user);
  try {
    return asPdfConfig(raw);
  } catch (e) {
    if (e instanceof AiError) throw e;
    throw new AiError("ai_invalid_output", "config failed validation");
  }
}
