// Keeps the favicon colors in sync with the app's effective light/dark theme.
//
// "Effective theme" = an explicit `.dark` / `.light` class on <html> (the app's
// theme strategy) if present, otherwise the OS `prefers-color-scheme`. The icon
// is rebuilt as an inline SVG data URI so it updates live — when the OS theme
// flips, or when a future theme toggle adds/removes the class on <html>.

type Palette = { tile: string; ink: string; edge: string };

const LIGHT: Palette = {
  tile: "#fbf9f5",
  ink: "#1f5d4c",
  edge: "rgba(31, 93, 76, 0.18)",
};

const DARK: Palette = {
  tile: "#16130f",
  ink: "#5fb39a",
  edge: "rgba(95, 179, 154, 0.24)",
};

function buildSvg({ tile, ink, edge }: Palette): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">\
<rect x="0.75" y="0.75" width="62.5" height="62.5" rx="14" fill="${tile}" stroke="${edge}" stroke-width="1.5"/>\
<g fill="none" stroke="${ink}" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round">\
<path d="M 21 18 L 21 35 C 21 44 25 48 32 48 C 39 48 43 44 43 35 L 43 18"/>\
</g>\
<g fill="${ink}">\
<rect x="14.5" y="14.5" width="13" height="5" rx="1.6"/>\
<rect x="36.5" y="14.5" width="13" height="5" rx="1.6"/>\
</g>\
</svg>`;
}

function prefersDark(): MediaQueryList {
  return window.matchMedia("(prefers-color-scheme: dark)");
}

function isDark(): boolean {
  const el = document.documentElement;
  if (el.classList.contains("dark")) return true;
  if (el.classList.contains("light")) return false;
  return prefersDark().matches;
}

function ensureLink(): HTMLLinkElement {
  let link = document.querySelector<HTMLLinkElement>("link#app-favicon");
  if (!link) {
    link = document.createElement("link");
    link.id = "app-favicon";
    link.rel = "icon";
    link.type = "image/svg+xml";
    document.head.appendChild(link);
  }
  return link;
}

function apply(): void {
  const svg = buildSvg(isDark() ? DARK : LIGHT);
  ensureLink().href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Set the favicon to match the current theme and keep it in sync with changes. */
export function initFavicon(): void {
  apply();

  // OS theme changes (when no explicit class forces the theme).
  prefersDark().addEventListener("change", apply);

  // App theme changes — a toggle adding/removing `.dark` / `.light` on <html>.
  new MutationObserver(apply).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
}
