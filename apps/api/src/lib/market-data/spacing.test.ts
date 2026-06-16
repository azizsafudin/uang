import { expect, test } from "bun:test";
import { spaceSeries } from "./spacing";

test("returns input unchanged when at or under the cap", () => {
  const pts = [1, 2, 3];
  expect(spaceSeries(pts, 5)).toEqual([1, 2, 3]);
  expect(spaceSeries(pts, 3)).toEqual([1, 2, 3]);
});

test("downsamples to evenly-spaced points including both endpoints", () => {
  const pts = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]; // n=10
  const out = spaceSeries(pts, 5);
  expect(out.length).toBe(5);
  expect(out[0]).toBe(0);              // first endpoint
  expect(out[out.length - 1]).toBe(9); // last endpoint
});

test("cap of 1 returns the most recent (last) point", () => {
  expect(spaceSeries([0, 1, 2, 3], 1)).toEqual([3]);
});

test("cap of 0 or less returns empty", () => {
  expect(spaceSeries([1, 2, 3], 0)).toEqual([]);
});
