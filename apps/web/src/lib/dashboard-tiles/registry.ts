export type TileAccount = { class: string; baseMinor: number; illiquid: boolean };

export type TileData = {
  baseCurrency: string;
  accounts: TileAccount[];
  goalsTotal: number;
  goalsOnTrack: number;
  periodDeltaMinor: number | null;
};

export type Tile = {
  id: string;
  label: string;
  isAvailable: (d: TileData) => boolean;
  // Numeric value in base minor units (or a count for goalsOnTrack).
  value: (d: TileData) => number;
  // Optional small subtitle line (e.g. "across 9 accounts").
  subtitle?: (d: TileData) => string;
};

const sumAssets = (d: TileData) =>
  d.accounts.filter((a) => a.class === "asset").reduce((s, a) => s + a.baseMinor, 0);
const sumLiabilities = (d: TileData) =>
  d.accounts.filter((a) => a.class === "liability").reduce((s, a) => s + a.baseMinor, 0);
const sumLiquid = (d: TileData) =>
  d.accounts.filter((a) => a.class === "asset" && !a.illiquid).reduce((s, a) => s + a.baseMinor, 0);
const countAssets = (d: TileData) => d.accounts.filter((a) => a.class === "asset").length;
const countLiabilities = (d: TileData) => d.accounts.filter((a) => a.class === "liability").length;

export const TILE_REGISTRY: Tile[] = [
  {
    id: "assets",
    label: "Assets",
    isAvailable: (d) => countAssets(d) > 0,
    value: sumAssets,
    subtitle: (d) => `across ${countAssets(d)} account${countAssets(d) === 1 ? "" : "s"}`,
  },
  {
    id: "liabilities",
    label: "Liabilities",
    isAvailable: (d) => countLiabilities(d) > 0,
    value: sumLiabilities,
    subtitle: (d) => `across ${countLiabilities(d)} account${countLiabilities(d) === 1 ? "" : "s"}`,
  },
  {
    id: "liquidAssets",
    label: "Liquid assets",
    isAvailable: (d) => d.accounts.some((a) => a.class === "asset" && !a.illiquid),
    value: sumLiquid,
  },
  {
    id: "goalsOnTrack",
    label: "Goals on track",
    isAvailable: (d) => d.goalsTotal > 0,
    value: (d) => d.goalsOnTrack,
    subtitle: (d) => `of ${d.goalsTotal}`,
  },
  {
    id: "periodChange",
    label: "Period change",
    isAvailable: (d) => d.periodDeltaMinor !== null,
    value: (d) => d.periodDeltaMinor ?? 0,
  },
];

const BY_ID = new Map(TILE_REGISTRY.map((t) => [t.id, t]));
export function getTile(id: string): Tile | undefined {
  return BY_ID.get(id);
}

export const DEFAULT_TILES = ["assets", "liabilities", "goalsOnTrack"];
