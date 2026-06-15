const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// Build a regex + capture plan from a token format string. Supported tokens:
// YYYY, YY, MMMM, MMM, MM, M, DD, D. Any other run of chars is treated literally.
type Part = { kind: "year" | "month" | "monthName" | "day" | "literal"; len?: number };

function compile(format: string): { re: RegExp; parts: Part[] } {
  const tokens = ["YYYY", "YY", "MMMM", "MMM", "MM", "M", "DD", "D"];
  const parts: Part[] = [];
  let src = "";
  let i = 0;
  while (i < format.length) {
    const tok = tokens.find((t) => format.startsWith(t, i));
    if (tok === "YYYY") { parts.push({ kind: "year" }); src += "(\\d{4})"; i += 4; }
    else if (tok === "YY") { parts.push({ kind: "year" }); src += "(\\d{2})"; i += 2; }
    else if (tok === "MMMM" || tok === "MMM") { parts.push({ kind: "monthName" }); src += "([A-Za-z]+)"; i += tok.length; }
    else if (tok === "MM") { parts.push({ kind: "month" }); src += "(\\d{1,2})"; i += 2; }
    else if (tok === "M") { parts.push({ kind: "month" }); src += "(\\d{1,2})"; i += 1; }
    else if (tok === "DD") { parts.push({ kind: "day" }); src += "(\\d{1,2})"; i += 2; }
    else if (tok === "D") { parts.push({ kind: "day" }); src += "(\\d{1,2})"; i += 1; }
    else { src += format[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); i += 1; }
  }
  return { re: new RegExp(`^\\s*${src}\\s*$`), parts };
}

export function parseDate(raw: string, format: string): string | null {
  if (!raw || !raw.trim()) return null;
  const { re, parts } = compile(format);
  const m = re.exec(raw);
  if (!m) return null;
  let year = 0, month = 0, day = 0;
  parts.forEach((p, idx) => {
    const g = m[idx + 1];
    if (p.kind === "year") year = g.length === 2 ? 2000 + Number(g) : Number(g);
    else if (p.kind === "month") month = Number(g);
    else if (p.kind === "monthName") month = MONTHS[g.slice(0, 3).toLowerCase()] ?? 0;
    else if (p.kind === "day") day = Number(g);
  });
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}
