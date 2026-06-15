import { expect, test } from "bun:test";
import { fingerprintCsv, matchParsers } from "./detect";

test("fingerprintCsv normalizes + sorts header columns", () => {
  const fp = fingerprintCsv("Date, Description ,Amount\nx,y,z", ",");
  expect(fp).toEqual({ format: "csv", delimiter: ",", headerColumns: ["amount", "date", "description"] });
});

test("matchParsers ranks by header overlap; exact set is confident", () => {
  const fp = fingerprintCsv("Date,Description,Amount\n", ",");
  const parsers = [
    { id: "p1", name: "DBS", fingerprint: { format: "csv" as const, delimiter: ",", headerColumns: ["amount", "date", "description"] } },
    { id: "p2", name: "Other", fingerprint: { format: "csv" as const, delimiter: ",", headerColumns: ["amount", "date"] } },
  ];
  const ranked = matchParsers(fp, parsers);
  expect(ranked[0]).toMatchObject({ parserId: "p1", confident: true });
  expect(ranked[0].score).toBe(1);
  expect(ranked[1].confident).toBe(false);
  expect(ranked[1].score).toBeLessThan(1);
});

import { fingerprintPdf, matchPdfParsers } from "./detect";

const STATEMENT = [
  "DBS Bank Statement of Account",
  "Customer Service 1800 111 1111",
  "Transaction Details",
  "02/01/2026 COFFEE BEAN -4.50",
  "03/01/2026 SALARY 2,500.00",
  "Closing Balance 9,999.00",
].join("\n");

test("fingerprintPdf extracts lowercased non-transaction marker lines", () => {
  const fp = fingerprintPdf(STATEMENT);
  expect(fp.format).toBe("pdf");
  expect(fp.markers).toContain("dbs bank statement of account");
  expect(fp.markers).toContain("transaction details");
  // transaction/amount lines are excluded
  expect(fp.markers.some((m) => m.includes("coffee bean"))).toBe(false);
});

test("matchPdfParsers scores by marker Jaccard and flags confident matches", () => {
  const fp = fingerprintPdf(STATEMENT);
  const saved = [{ id: "p1", name: "DBS", fingerprint: fingerprintPdf(STATEMENT) }];
  const out = matchPdfParsers(fp, saved);
  expect(out[0].parserId).toBe("p1");
  expect(out[0].score).toBe(1);
  expect(out[0].confident).toBe(true);
});

test("matchPdfParsers filters out a CSV fingerprint mixed into the saved list", () => {
  const fp = fingerprintPdf(STATEMENT);
  const saved = [
    { id: "pdf1", name: "DBS", fingerprint: fingerprintPdf(STATEMENT) },
    { id: "csv1", name: "Some CSV", fingerprint: fingerprintCsv("Date,Desc,Amount", ",") },
  ];
  const out = matchPdfParsers(fp, saved);
  expect(out.map((c) => c.parserId)).toEqual(["pdf1"]); // the CSV parser is excluded
});

test("matchPdfParsers marks a low-overlap match as not confident", () => {
  const fp = fingerprintPdf(STATEMENT); // markers incl. "dbs bank statement of account", "customer service 1800 111 1111", "transaction details", "closing balance 9,999.00"
  // A saved parser sharing only 1 of the relevant markers → Jaccard well below 0.6.
  const partial = { format: "pdf" as const, markers: ["transaction details", "uob one account", "interest summary"] };
  const out = matchPdfParsers(fp, [{ id: "p1", name: "UOB", fingerprint: partial }]);
  expect(out[0].score).toBeGreaterThan(0);
  expect(out[0].score).toBeLessThan(0.6);
  expect(out[0].confident).toBe(false);
});
