import { expect, test } from "bun:test";
import { TILE_REGISTRY, getTile, type TileData } from "./registry";

const base: TileData = {
  baseCurrency: "GBP",
  accounts: [
    { class: "asset", baseMinor: 31_240_000, illiquid: false },
    { class: "asset", baseMinor: 5_000_000, illiquid: true },
    { class: "liability", baseMinor: 2_749_000, illiquid: false },
  ],
  assetAccounts: [],
  goalsTotal: 4,
  goalsOnTrack: 3,
  periodDeltaMinor: 524_000,
};

test("assets tile sums asset accounts", () => {
  const tile = getTile("assets")!;
  expect(tile.isAvailable(base)).toBe(true);
  expect(tile.value(base)).toBe(36_240_000);
});

test("liabilities tile sums liability accounts", () => {
  expect(getTile("liabilities")!.value(base)).toBe(2_749_000);
});

test("goalsOnTrack is unavailable when there are no goals", () => {
  const tile = getTile("goalsOnTrack")!;
  expect(tile.isAvailable(base)).toBe(true);
  expect(tile.isAvailable({ ...base, goalsTotal: 0 })).toBe(false);
});

test("periodChange is unavailable without a delta", () => {
  expect(getTile("periodChange")!.isAvailable({ ...base, periodDeltaMinor: null })).toBe(false);
});

test("simpleIncome applies the 4% rule to net worth (annual + monthly)", () => {
  const tile = getTile("simpleIncome")!;
  // Net worth = assets minus liabilities (liabilities stored negative).
  const nwData: TileData = {
    ...base,
    accounts: [
      { class: "asset", baseMinor: 50_000_000, illiquid: false },
      { class: "liability", baseMinor: -10_000_000, illiquid: false },
    ],
  };
  // net worth 40,000,000 -> 4% = 1,600,000/yr -> /12 = 133,333/mo
  expect(tile.isAvailable(nwData)).toBe(true);
  expect(tile.value(nwData)).toBe(1_600_000);
  expect(tile.subMoney!(nwData)).toBe(133_333);
  expect(tile.isAvailable({ ...nwData, accounts: [] })).toBe(false);
});

test("registry ids are unique", () => {
  const ids = TILE_REGISTRY.map((t) => t.id);
  expect(new Set(ids).size).toBe(ids.length);
});
