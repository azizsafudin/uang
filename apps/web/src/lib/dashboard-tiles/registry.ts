import type { AccountValuation } from "@/lib/account-grouping";

export type TileAccount = { class: string; baseMinor: number; illiquid: boolean };

export type TileData = {
  baseCurrency: string;
  accounts: TileAccount[];
  // Full asset accounts (owner-filtered) — needed by breakdown tiles to bucket
  // by liquidity/owner. Numeric tiles use the lighter `accounts` list above.
  assetAccounts: AccountValuation[];
  goalsTotal: number;
  goalsOnTrack: number;
  periodDeltaMinor: number | null;
};

export type Tile = {
  id: string;
  label: string;
  isAvailable: (d: TileData) => boolean;
  // Numeric value in base minor units (or a count for goalsOnTrack). Omitted for
  // breakdown tiles, which render a donut instead of a single figure.
  value?: (d: TileData) => number;
  // When set, the tile renders an allocation donut of the asset accounts bucketed
  // by this dimension instead of a numeric figure.
  breakdown?: "liquidity" | "owner";
  // Optional suffix appended after the primary value (e.g. "/yr").
  valueSuffix?: string;
  // Optional small subtitle line (e.g. "across 9 accounts").
  subtitle?: (d: TileData) => string;
  // Optional money subtitle in base minor units (privacy-masked), e.g. monthly
  // income below an annual figure. Rendered with subMoneySuffix (e.g. "/mo").
  subMoney?: (d: TileData) => number;
  subMoneySuffix?: string;
};

const sumAssets = (d: TileData) =>
  d.accounts.filter((a) => a.class === "asset").reduce((s, a) => s + a.baseMinor, 0);
const sumLiabilities = (d: TileData) =>
  d.accounts.filter((a) => a.class === "liability").reduce((s, a) => s + a.baseMinor, 0);
const countAssets = (d: TileData) => d.accounts.filter((a) => a.class === "asset").length;
const countLiabilities = (d: TileData) => d.accounts.filter((a) => a.class === "liability").length;
// Net worth = assets minus liabilities (liability balances are stored negative).
const netWorth = (d: TileData) => d.accounts.reduce((s, a) => s + a.baseMinor, 0);
// Simple 4% safe-withdrawal rule, applied to total net worth.
const SAFE_WITHDRAWAL_RATE = 0.04;
const annualIncome = (d: TileData) => Math.round(netWorth(d) * SAFE_WITHDRAWAL_RATE);

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
    id: "liquidityMix",
    label: "Liquidity",
    isAvailable: (d) => countAssets(d) > 0,
    breakdown: "liquidity",
  },
  {
    id: "ownerMix",
    label: "Owner",
    isAvailable: (d) => countAssets(d) > 0,
    breakdown: "owner",
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
  {
    id: "simpleIncome",
    label: "Simple income",
    // 4% of net worth per year, with the monthly equivalent below.
    isAvailable: (d) => netWorth(d) > 0,
    value: annualIncome,
    valueSuffix: "/yr",
    subMoney: (d) => Math.round(annualIncome(d) / 12),
    subMoneySuffix: "/mo",
  },
];

const BY_ID = new Map(TILE_REGISTRY.map((t) => [t.id, t]));
export function getTile(id: string): Tile | undefined {
  return BY_ID.get(id);
}

export const DEFAULT_TILES = ["assets", "liabilities", "goalsOnTrack"];
