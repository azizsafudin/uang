import { expect, test } from "bun:test";
import { synthesizeCsvConfig, capSample, AiError, type AiConfig } from "./ai";

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

import { chatJson } from "./ai";
import { startMockAi } from "./ai-server.test-helper";

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
