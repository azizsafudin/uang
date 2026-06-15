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
