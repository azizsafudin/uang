import { parseDelimited } from "./csv";
import type { CsvFingerprint, PdfFingerprint } from "./types";

export function fingerprintCsv(content: string, delimiter: string): CsvFingerprint {
  const rows = parseDelimited(content, delimiter);
  const header = (rows[0] ?? [])
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== "");
  return { format: "csv", delimiter, headerColumns: [...header].sort() };
}

export interface ParserCandidate {
  parserId: string;
  name: string;
  score: number;     // Jaccard similarity of header sets (0..1)
  confident: boolean;
}

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a), sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function matchParsers(
  fp: CsvFingerprint,
  parsers: Array<{ id: string; name: string; fingerprint: CsvFingerprint }>,
): ParserCandidate[] {
  return parsers
    .filter((p) => p.fingerprint.format === "csv")
    .map((p) => {
      const score = jaccard(fp.headerColumns, p.fingerprint.headerColumns);
      const confident = score === 1 && p.fingerprint.delimiter === fp.delimiter;
      return { parserId: p.id, name: p.name, score, confident };
    })
    .sort((a, b) => b.score - a.score);
}

// Build a marker fingerprint from extracted PDF text: stable header/footer phrases
// (issuer/bank name, section headers) that recur across statements of one format.
// Skip lines that look like transactions (dates/amounts) and out-of-range lengths.
export function fingerprintPdf(text: string): PdfFingerprint {
  const markers: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim().toLowerCase();
    if (l.length < 4 || l.length > 60) continue;
    if (/\d{1,4}[/-]\d{1,2}[/-]\d{1,4}/.test(l)) continue; // dates
    if (/\d[\d,]*\.\d{2}/.test(l)) continue;               // amounts
    if (seen.has(l)) continue;
    seen.add(l);
    markers.push(l);
    if (markers.length >= 12) break;
  }
  return { format: "pdf", markers };
}

export function matchPdfParsers(
  fp: PdfFingerprint,
  parsers: Array<{ id: string; name: string; fingerprint: PdfFingerprint }>,
): ParserCandidate[] {
  return parsers
    .filter((p) => p.fingerprint.format === "pdf")
    .map((p) => {
      const score = jaccard(fp.markers, p.fingerprint.markers);
      return { parserId: p.id, name: p.name, score, confident: score >= 0.6 };
    })
    .sort((a, b) => b.score - a.score);
}
