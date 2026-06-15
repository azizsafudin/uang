import { validateParserConfig } from "./validate";
import type { CsvParserConfig } from "./types";

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
        response_format: { type: "json_object" },
        temperature: 0,
      }),
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
    return JSON.parse(content);
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

type Chat = (cfg: AiConfig, system: string, user: string) => Promise<unknown>;
const defaultChat: Chat = (cfg, s, u) => chatJson(cfg, s, u);

export async function synthesizeCsvConfig(
  sample: string,
  cfg: AiConfig,
  chat: Chat = defaultChat,
): Promise<CsvParserConfig> {
  const raw = await chat(cfg, SYSTEM, `Sample CSV (headers + rows):\n${sample}`);
  try {
    return validateParserConfig(raw);
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
    return validateParserConfig(raw);
  } catch {
    throw new AiError("ai_invalid_output", "config failed validation");
  }
}
