import { extractText } from "unpdf";

export type PdfErrorCode = "pdf_encrypted" | "pdf_no_text";

export class PdfExtractError extends Error {
  constructor(public code: PdfErrorCode) { super(code); this.name = "PdfExtractError"; }
}

// Map an unpdf/pdf.js error to a known code, or null if it's not one we handle.
export function classifyPdfError(err: unknown): PdfErrorCode | null {
  const name = err instanceof Error ? err.name : "";
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (name === "PasswordException" || msg.includes("password") || msg.includes("encrypt")) return "pdf_encrypted";
  return null;
}

// Extract the concatenated text layer from PDF bytes. Pages are joined with "\n".
// Throws PdfExtractError("pdf_encrypted") for password-protected PDFs and
// PdfExtractError("pdf_no_text") for scanned/image PDFs with no extractable text.
export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  let pages: string[];
  try {
    const res = await extractText(bytes, { mergePages: false });
    pages = Array.isArray(res.text) ? res.text : [res.text];
  } catch (err) {
    const code = classifyPdfError(err);
    if (code) throw new PdfExtractError(code);
    throw err;
  }
  // Clean up extraction artifacts WITHOUT destroying intra-line spaces (tests assert
  // multi-word phrases like "DBS Bank Statement of Account" survive verbatim):
  // strip embedded NUL chars, collapse trailing whitespace before newlines, then trim ends.
  const text = pages.join("\n").replace(/\0/g, "").replace(/[ \t]+\n/g, "\n").trim();
  if (text.length === 0) throw new PdfExtractError("pdf_no_text");
  return text;
}
