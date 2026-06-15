import { parseDelimited } from "./csv";
import type { CsvFingerprint } from "./types";

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
