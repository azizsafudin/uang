// Source of truth for group header colors on the web client.
// The key list must stay in sync with GROUP_COLOR_KEYS in
// apps/api/src/routes/groups.ts (server-side validation).

export type GroupColorDef = {
  /** Semantic key persisted to the DB. */
  key: GroupColor;
  /** Human label for accessibility (aria-label / title). */
  label: string;
  /** Base color used for header text and as the tint source. oklch keeps it
   *  perceptually even across the 12 hues and readable in both themes. */
  base: string;
};

export const GROUP_COLORS = [
  { key: "slate",  label: "Slate",  base: "oklch(0.55 0.04 256)" },
  { key: "red",    label: "Red",    base: "oklch(0.58 0.20 25)" },
  { key: "orange", label: "Orange", base: "oklch(0.62 0.17 50)" },
  { key: "amber",  label: "Amber",  base: "oklch(0.66 0.15 75)" },
  { key: "yellow", label: "Yellow", base: "oklch(0.68 0.14 100)" },
  { key: "lime",   label: "Lime",   base: "oklch(0.64 0.18 130)" },
  { key: "green",  label: "Green",  base: "oklch(0.58 0.16 150)" },
  { key: "teal",   label: "Teal",   base: "oklch(0.60 0.12 185)" },
  { key: "cyan",   label: "Cyan",   base: "oklch(0.62 0.13 215)" },
  { key: "blue",   label: "Blue",   base: "oklch(0.58 0.17 250)" },
  { key: "violet", label: "Violet", base: "oklch(0.55 0.20 290)" },
  { key: "pink",   label: "Pink",   base: "oklch(0.62 0.20 350)" },
] as const satisfies ReadonlyArray<{ key: string; label: string; base: string }>;

export type GroupColor = (typeof GROUP_COLORS)[number]["key"];

const BY_KEY = new Map<string, GroupColorDef>(GROUP_COLORS.map((c) => [c.key, c]));

/** Resolve a stored key to its base color, or null for null/unknown keys. */
export function resolveGroupColor(key: string | null | undefined): string | null {
  if (!key) return null;
  return BY_KEY.get(key)?.base ?? null;
}
