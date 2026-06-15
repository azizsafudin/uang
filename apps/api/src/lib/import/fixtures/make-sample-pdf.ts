// Generates the committed fixture PDFs used by pdf-text tests and the e2e PDF spec.
// Each statement line is drawn as ONE `(...) Tj` text-show op, so unpdf extracts
// each line back verbatim. Run with: `bun run src/lib/import/fixtures/make-sample-pdf.ts`
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const SAMPLE_STATEMENT_LINES = [
  "DBS Bank Statement of Account",
  "Customer Service 1800 111 1111",
  "Transaction Details",
  "02/01/2026 COFFEE BEAN -4.50",
  "03/01/2026 SALARY 2,500.00",
  "Closing Balance 9,999.00",
  "Page 1 of 1",
];

// Build a minimal single-page PDF whose content stream prints `lines`, one per row.
// Offsets for the xref table are computed from byte positions (content is ASCII).
export function buildStatementPdf(lines: string[]): Uint8Array {
  let content = "BT /F1 12 Tf 72 720 Td 14 TL\n";
  lines.forEach((l, i) => {
    const esc = l.replace(/([\\()])/g, "\\$1");
    content += i === 0 ? `(${esc}) Tj\n` : `T* (${esc}) Tj\n`;
  });
  content += "ET";

  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((off) => { pdf += `${String(off).padStart(10, "0")} 00000 n \n`; });
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

if (import.meta.main) {
  const dir = import.meta.dir;
  writeFileSync(join(dir, "sample-statement.pdf"), buildStatementPdf(SAMPLE_STATEMENT_LINES));
  writeFileSync(join(dir, "sample-empty.pdf"), buildStatementPdf([])); // page, no text ops
  console.log("wrote sample-statement.pdf and sample-empty.pdf");
}
