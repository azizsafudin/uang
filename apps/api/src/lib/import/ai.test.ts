import { expect, test } from "bun:test";
import { synthesizeCsvConfig, capSample, AiError, type AiConfig, synthesizePdfConfig, refinePdfConfig, capPdfSample } from "./ai";

const cfg: AiConfig = { baseUrl: "http://x/v1", model: "m" };
const goodConfig = {
  version: 1, format: "csv", csv: { delimiter: ",", headerRow: 0, skipRows: 0 },
  fields: {
    date: { column: "Date", format: "YYYY-MM-DD" },
    description: { column: "Desc" },
    amount: { mode: "single", column: "Amount", decimal: ".", thousands: ",", sign: "negativeIsDebit" },
  },
};

test("synthesize returns a validated config from the model's JSON", async () => {
  const chat = async () => goodConfig; // injected fake chat
  const out = await synthesizeCsvConfig("Date,Desc,Amount\n2026-01-01,X,-1.00", cfg, chat);
  expect(out.fields.amount.mode).toBe("single");
});

test("synthesize rejects model output that fails config validation", async () => {
  const chat = async () => ({ version: 1, format: "csv" }); // incomplete
  await expect(synthesizeCsvConfig("x", cfg, chat)).rejects.toThrow(AiError);
});

test("capSample trims a 100-row CSV to the header + 20 rows (21 lines)", () => {
  const header = "Date,Desc,Amount";
  const rows = Array.from({ length: 100 }, (_, i) => `2026-01-${i + 1},X,-1.00`);
  const csv = [header, ...rows].join("\n");
  const out = capSample(csv);
  const lines = out.split("\n");
  expect(lines.length).toBe(21);
  expect(lines[0]).toBe(header);
});

import { chatJson, extractJsonObject } from "./ai";
import { startMockAi } from "./ai-server.test-helper";

test("extractJsonObject parses clean JSON", () => {
  expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
});

test("extractJsonObject strips ```json code fences (Claude/Anthropic style)", () => {
  const fenced = "```json\n{\n  \"format\": \"pdf\"\n}\n```";
  expect(extractJsonObject(fenced)).toEqual({ format: "pdf" });
});

test("extractJsonObject tolerates surrounding prose", () => {
  expect(extractJsonObject('Sure! Here is the config:\n{"x":2}\nLet me know.')).toEqual({ x: 2 });
});

test("chatJson parses a code-fenced response (portable across providers)", async () => {
  const mock = startMockAi("```json\n{\"ok\":true}\n```", { rawContent: true });
  try {
    const out = await chatJson({ baseUrl: mock.baseUrl, model: "m" }, "s", "u");
    expect(out).toEqual({ ok: true });
  } finally {
    mock.stop();
  }
});

test("chatJson posts to {baseUrl}/chat/completions and parses the JSON content", async () => {
  const mock = startMockAi({ hello: "world" });
  try {
    const out = await chatJson({ baseUrl: mock.baseUrl, model: "m" }, "sys", "usr");
    expect(out).toEqual({ hello: "world" });
  } finally {
    mock.stop();
  }
});

test("chatJson maps a 500 to ai_unavailable", async () => {
  const mock = startMockAi({}, { status: 500 });
  try {
    await expect(chatJson({ baseUrl: mock.baseUrl, model: "m" }, "s", "u")).rejects.toThrow("ai_unavailable");
  } finally {
    mock.stop();
  }
});

test("chatJson maps non-JSON content to ai_invalid_output", async () => {
  const mock = startMockAi({}, { bad: true });
  try {
    await expect(chatJson({ baseUrl: mock.baseUrl, model: "m" }, "s", "u")).rejects.toThrow("ai_invalid_output");
  } finally {
    mock.stop();
  }
});

const goodPdf = {
  version: 1, format: "pdf",
  region: { startAfter: "Transaction Details", stopAt: "Closing Balance" },
  transactionLine: "^(?<date>\\d{2}/\\d{2}/\\d{4})\\s+(?<description>.+?)\\s+(?<amount>-?[\\d,]+\\.\\d{2})$",
  date: { format: "DD/MM/YYYY" },
  amount: { decimal: ".", thousands: ",", sign: "negativeIsDebit" },
};

test("synthesizePdfConfig returns a validated pdf config from the model's JSON", async () => {
  const chat = async () => goodPdf;
  const out = await synthesizePdfConfig("Transaction Details\n02/01/2026 X -1.00\nClosing Balance", cfg, chat);
  expect(out.format).toBe("pdf");
  expect(out.transactionLine).toContain("(?<amount>");
});

test("synthesizePdfConfig rejects a model that returns a CSV config", async () => {
  const chat = async () => goodConfig; // CSV shape from the existing tests above
  await expect(synthesizePdfConfig("x", cfg, chat)).rejects.toThrow(AiError);
});

test("refinePdfConfig returns a new validated pdf config", async () => {
  const chat = async () => goodPdf;
  const out = await refinePdfConfig("sample", goodPdf, "fix dates", [], cfg, chat);
  expect(out.format).toBe("pdf");
});

test("capPdfSample caps to ~8KB on a line boundary", () => {
  const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
  const out = capPdfSample(big);
  expect(out.length).toBeLessThanOrEqual(8000);
  expect(out.endsWith("\n")).toBe(false); // trimmed to last full line
});
