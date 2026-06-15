import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractPdfText, classifyPdfError, PdfExtractError } from "./pdf-text";

const fixture = (name: string) => new Uint8Array(readFileSync(join(import.meta.dir, "fixtures", name)));

test("extractPdfText returns the text layer of a text PDF", async () => {
  const text = await extractPdfText(fixture("sample-statement.pdf"));
  expect(text).toContain("DBS Bank Statement of Account");
  expect(text).toContain("Transaction Details");
  expect(text).toContain("COFFEE BEAN");
});

test("extractPdfText throws pdf_no_text for a page with no text layer", async () => {
  await expect(extractPdfText(fixture("sample-empty.pdf"))).rejects.toMatchObject({ code: "pdf_no_text" });
});

test("classifyPdfError maps a PasswordException to pdf_encrypted", () => {
  const err = Object.assign(new Error("No password given"), { name: "PasswordException" });
  expect(classifyPdfError(err)).toBe("pdf_encrypted");
});

test("classifyPdfError returns null for an unrelated error", () => {
  expect(classifyPdfError(new Error("boom"))).toBeNull();
});

test("PdfExtractError carries its code", () => {
  expect(new PdfExtractError("pdf_no_text").code).toBe("pdf_no_text");
});
