import { parseDate } from "./dates";
import { parseAmountToMinor } from "./amount";
import type { CanonicalRow, PdfParserConfig } from "./types";

// Slice the lines down to the transaction section using the optional regex anchors.
// startAfter: first line matching it is excluded; everything after begins the section.
// stopAt: first line matching it (at or after the start) ends the section (excluded).
function sliceRegion(lines: string[], region?: PdfParserConfig["region"]): string[] {
  if (!region) return lines;
  let start = 0;
  let end = lines.length;
  if (region.startAfter) {
    const re = new RegExp(region.startAfter);
    const i = lines.findIndex((l) => re.test(l));
    if (i >= 0) start = i + 1;
  }
  if (region.stopAt) {
    const re = new RegExp(region.stopAt);
    for (let i = start; i < lines.length; i++) {
      if (re.test(lines[i])) { end = i; break; }
    }
  }
  return lines.slice(start, end);
}

// Run a validated PDF parser config over extracted statement text.
// The config MUST have passed validateParserConfig (regexes are compiled here).
export function runPdfParser(text: string, config: PdfParserConfig, currency: string): CanonicalRow[] {
  const lineRe = new RegExp(config.transactionLine);
  // Trim trailing whitespace per line: PDF extraction often leaves trailing spaces
  // that would break a `$`-anchored regex. Leading whitespace is preserved.
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+$/, ""));
  const region = sliceRegion(lines, config.region);
  const out: CanonicalRow[] = [];

  for (const line of region) {
    const m = lineRe.exec(line);
    if (!m || !m.groups) {
      if (config.multiline?.continuationAppendsTo === "description" && out.length > 0 && line.trim() !== "") {
        const prev = out[out.length - 1];
        prev.description = `${prev.description} ${line.trim()}`.trim();
        prev.raw.description = prev.description; // keep the audit copy in sync with the merged description
        prev.raw.line = `${prev.raw.line ?? ""}\n${line}`;
      }
      continue;
    }
    const g = m.groups;
    const raw: Record<string, string> = { line };
    for (const [k, v] of Object.entries(g)) if (typeof v === "string") raw[k] = v;

    const date = parseDate(g.date ?? "", config.date.format);
    let amountMinor = parseAmountToMinor(g.amount ?? "", {
      decimal: config.amount.decimal, thousands: config.amount.thousands, currency,
    });
    if (amountMinor !== null && config.amount.sign === "positiveIsDebit") amountMinor = -amountMinor;

    const row: CanonicalRow = { raw, date, amountMinor, description: (g.description ?? "").trim() };
    if (date === null) row.error = "unparseable_date";
    else if (amountMinor === null) row.error = "unparseable_amount";
    out.push(row);
  }
  return out;
}
